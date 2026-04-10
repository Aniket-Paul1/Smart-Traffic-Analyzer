import glob
import os
import time
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import pandas as pd
from stable_baselines3 import DQN


# ---------------- CONFIG ----------------
VIDEO_FOLDER = "videos"
CSV_FOLDER = "logs"
DECISION_LOG_FILE = "logs/rl_decisions.csv"

GRID_ROWS = 3
GRID_COLS = 3

# Output window size (should be >= 300x300 for readability).
OUT_WIDTH = 960
OUT_HEIGHT = 720

MIN_GREEN_SEC = 40.0
MAX_GREEN_SEC = 90.0

SHOW_WINDOW = True

DURATION_MODEL_PATHS = [
    "duration_dqn.zip",
    "duration_dqn",
]


def _load_density_series(csv_path: str) -> Optional[np.ndarray]:
    """
    Loads a 1D density time series from a per-video CSV.
    Supported columns:
      - `density` (legacy)
      - `density_lane_0` (canonical single-lane logs)
    """
    try:
        df = pd.read_csv(csv_path)
    except Exception:
        return None

    if "density" in df.columns:
        series = pd.to_numeric(df["density"], errors="coerce").fillna(0.0).values.astype(np.float32)
        return series

    if "density_lane_0" in df.columns:
        series = (
            pd.to_numeric(df["density_lane_0"], errors="coerce")
            .fillna(0.0)
            .values.astype(np.float32)
        )
        return series

    # Fallback: any density_lane_i column -> use lane_0 if present, else first.
    density_cols = [c for c in df.columns if str(c).startswith("density_lane_")]
    if density_cols:
        c0 = sorted(density_cols, key=lambda s: int(str(s).split("_")[-1]))[0]
        series = pd.to_numeric(df[c0], errors="coerce").fillna(0.0).values.astype(np.float32)
        return series

    return None


def _load_duration_model() -> Tuple[Optional[DQN], bool]:
    for p in DURATION_MODEL_PATHS:
        try:
            return DQN.load(p), True
        except Exception:
            continue
    print("Duration RL model not found. Falling back to density-based heuristic durations.")
    return None, False


def _get_expected_obs_n_lanes(model: DQN) -> int:
    # Stable-Baselines3 stores it in the policy.
    shp = model.policy.observation_space.shape
    if hasattr(shp, "__len__") and len(shp) >= 1:
        return int(shp[0])
    raise RuntimeError("Could not infer expected observation shape from RL model.")


def _adapt_obs(obs: np.ndarray, expected_n_lanes: int) -> np.ndarray:
    obs = np.asarray(obs, dtype=np.float32).reshape(-1)
    n = int(obs.shape[0])
    if n == expected_n_lanes:
        return obs
    if n < expected_n_lanes:
        out = np.zeros((expected_n_lanes,), dtype=np.float32)
        out[:n] = obs
        return out
    return obs[:expected_n_lanes]


def _cell_geometry() -> Tuple[int, int, int, int]:
    cell_w = OUT_WIDTH // GRID_COLS
    cell_h = OUT_HEIGHT // GRID_ROWS
    if cell_w <= 0 or cell_h <= 0:
        raise ValueError("OUT_WIDTH/OUT_HEIGHT too small for 3x3 grid.")
    return cell_w, cell_h, OUT_WIDTH, OUT_HEIGHT


def _make_null_frame(cell_w: int, cell_h: int) -> np.ndarray:
    f = np.zeros((cell_h, cell_w, 3), dtype=np.uint8)
    cv2.putText(
        f,
        "NULL",
        (max(5, cell_w // 10), max(30, cell_h // 5)),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.0,
        (80, 80, 80),
        2,
        cv2.LINE_AA,
    )
    return f


def main():
    cell_w, cell_h, _, _ = _cell_geometry()

    video_files = sorted(glob.glob(os.path.join(VIDEO_FOLDER, "*.mp4")))
    if not video_files:
        raise FileNotFoundError(f"No .mp4 videos found in {VIDEO_FOLDER}")

    duration_model, has_duration_rl = _load_duration_model()
    expected_n_lanes = _get_expected_obs_n_lanes(duration_model) if (has_duration_rl and duration_model is not None) else 1

    # Build 3x3 cells. Fill left-to-right with available (video + csv) pairs.
    num_cells = GRID_ROWS * GRID_COLS
    available_cells: List[int] = []
    cell_video_paths: Dict[int, str] = {}
    cell_csv_paths: Dict[int, str] = {}

    for cell_idx in range(num_cells):
        if cell_idx >= len(video_files):
            continue
        video_path = video_files[cell_idx]
        base = os.path.splitext(os.path.basename(video_path))[0]
        csv_path = os.path.join(CSV_FOLDER, f"{base}_timeseries.csv")
        if os.path.exists(csv_path):
            available_cells.append(cell_idx)
            cell_video_paths[cell_idx] = video_path
            cell_csv_paths[cell_idx] = csv_path

    if not available_cells:
        raise RuntimeError(f"No valid (video + csv) pairs found. Checked csv in '{CSV_FOLDER}'.")

    # Load caps and density series for each available cell.
    caps: Dict[int, cv2.VideoCapture] = {}
    fps: Dict[int, float] = {}
    frame_counts: Dict[int, int] = {}
    densities: Dict[int, np.ndarray] = {}
    density_pos: Dict[int, int] = {}
    # Internal frames always advance (used for correct density/timing logic).
    internal_frames: Dict[int, np.ndarray] = {}
    # Display frames are what the user sees; red lanes stay frozen.
    display_frames: Dict[int, np.ndarray] = {}

    global_max_density = 1.0
    cell_max_density: Dict[int, float] = {}
    for cell_idx in available_cells:
        cap = cv2.VideoCapture(cell_video_paths[cell_idx])
        if not cap.isOpened():
            continue

        cap_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        cap_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        dens = _load_density_series(cell_csv_paths[cell_idx])
        if dens is None or len(dens) == 0:
            cap.release()
            continue

        global_max_density = max(global_max_density, float(np.max(dens)))
        cell_max_density[cell_idx] = float(np.max(dens)) if len(dens) else 1.0
        if cell_max_density[cell_idx] <= 0.0:
            cell_max_density[cell_idx] = 1.0

        caps[cell_idx] = cap
        fps[cell_idx] = float(cap_fps)
        frame_counts[cell_idx] = int(cap_frames) if cap_frames > 0 else len(dens)
        densities[cell_idx] = dens
        density_pos[cell_idx] = 0

        # Prime the first visible frame.
        ret, fr = cap.read()
        if not ret or fr is None:
            fr = np.zeros((cell_h, cell_w, 3), dtype=np.uint8)
        fr = cv2.resize(fr, (cell_w, cell_h))
        internal_frames[cell_idx] = fr
        display_frames[cell_idx] = fr.copy()

    # Remove any cells that failed to load.
    available_cells = [c for c in available_cells if c in caps and c in densities]
    if not available_cells:
        raise RuntimeError("All cells failed to initialize (caps/densities).")

    null_frame = _make_null_frame(cell_w, cell_h)
    decision_records: List[Dict] = []

    # Round-robin order across available videos (left-to-right, then wrap).
    rr_cells = sorted(available_cells)
    if not rr_cells:
        raise RuntimeError("No available cells to simulate.")

    green_cell = rr_cells[0]
    decision_id = 0
    start_time = time.time()

    def _smoothed_density(cell_idx: int) -> float:
        """
        Returns a smoothed density value for the given cell (using a small
        moving window around the current density_pos).
        """
        pos = density_pos.get(cell_idx, 0) % len(densities[cell_idx])
        win = 5
        lo = max(0, pos - win)
        hi = min(len(densities[cell_idx]), pos + 1)
        if hi > lo:
            return float(np.mean(densities[cell_idx][lo:hi]))
        return float(densities[cell_idx][pos])

    def decide_next_duration(cell_idx: int) -> float:
        """
        Decide green duration (in seconds) for the given cell using a
        deterministic mapping:

        - At each decision, we compare the current cell's smoothed density
          against the min/max smoothed densities across ALL active cells.
        - The emptiest lane gets ~40s, the most congested gets ~90s,
          and others are linearly mapped in between.
        """
        # Compute smoothed densities for all cells in this round.
        smoothed = {c: _smoothed_density(c) for c in rr_cells}
        d_min = min(smoothed.values()) if smoothed else 0.0
        d_max = max(smoothed.values()) if smoothed else 1.0
        if d_max <= d_min:
            # All lanes effectively equal: give them mid-range time.
            return 0.5 * (MIN_GREEN_SEC + MAX_GREEN_SEC)

        d_here = smoothed[cell_idx]
        dens_norm = float((d_here - d_min) / (d_max - d_min))
        dens_norm = float(np.clip(dens_norm, 0.0, 1.0))

        duration = MIN_GREEN_SEC + (MAX_GREEN_SEC - MIN_GREEN_SEC) * dens_norm
        return float(np.clip(duration, MIN_GREEN_SEC, MAX_GREEN_SEC))

    green_duration_sec = decide_next_duration(green_cell)
    green_end_time = time.time() + green_duration_sec
    green_rr_ptr = 0

    while True:
        loop_start = time.time()

        now = time.time()

        # If we've run out of green time, move to the next cell (round robin),
        # and let the duration decision logic compute the new GREEN duration.
        if now >= green_end_time:
            # Advance in fixed left-to-right order; only wrap back to the first
            # cell after the full rr_cells list is exhausted.
            green_rr_ptr += 1
            if green_rr_ptr >= len(rr_cells):
                green_rr_ptr = 0
            green_cell = rr_cells[green_rr_ptr]
            green_duration_sec = decide_next_duration(green_cell)
            green_end_time = time.time() + green_duration_sec
            # Refresh now so the countdown display starts from the new duration.
            now = time.time()

            pos = density_pos.get(green_cell, 0) % len(densities[green_cell])
            dens_sel = float(densities[green_cell][pos]) / float(global_max_density if global_max_density > 0 else 1.0)
            dens_sel = float(np.clip(dens_sel, 0.0, 1.0))
            decision_records.append(
                {
                    "decision_id": decision_id,
                    "green_cell": green_cell,
                    "duration_sec": float(green_duration_sec),
                    "density_norm_at_start": dens_sel,
                    "elapsed_sec": now - start_time,
                }
            )
            decision_id += 1

        # Advance all lanes internally (so density-based timing stays correct),
        # but only update the DISPLAY frame for the active GREEN lane.
        for cell_idx in rr_cells:
            if cell_idx not in caps:
                continue
            cap = caps[cell_idx]
            ret, fr = cap.read()
            if not ret or fr is None:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret2, fr2 = cap.read()
                if ret2 and fr2 is not None:
                    fr = fr2
                else:
                    fr = internal_frames.get(cell_idx, np.zeros((cell_h, cell_w, 3), dtype=np.uint8))

            internal_frames[cell_idx] = cv2.resize(fr, (cell_w, cell_h))
            density_pos[cell_idx] = (density_pos[cell_idx] + 1) % len(densities[cell_idx])

        # Update what the user sees:
        # - GREEN lane plays
        # - RED lanes stay frozen
        if green_cell in internal_frames:
            display_frames[green_cell] = internal_frames[green_cell].copy()

        # Build display grid.
        now_display = time.time()
        rows = []
        for r in range(GRID_ROWS):
            row_frames = []
            for c in range(GRID_COLS):
                idx = r * GRID_COLS + c
                if idx not in display_frames:
                    row_frames.append(null_frame)
                    continue
                disp = display_frames[idx].copy()
                is_green = idx == green_cell
                border_color = (0, 255, 0) if is_green else (0, 0, 255)
                cv2.rectangle(disp, (0, 0), (cell_w - 1, cell_h - 1), border_color, 3)
                cv2.putText(
                    disp,
                    f"V{idx + 1}",
                    (8, 26),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
                cv2.putText(
                    disp,
                    "GREEN" if is_green else "RED",
                    (8, cell_h - 16),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 255, 0) if is_green else (0, 0, 255),
                    2,
                    cv2.LINE_AA,
                )

                # Show countdown timer only on the active GREEN cell.
                if is_green:
                    time_left = max(0.0, float(green_end_time - now_display))
                    cv2.putText(
                        disp,
                        f"Time Left: {time_left:0.1f}s",
                        (8, cell_h - 46),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (255, 255, 255),
                        2,
                        cv2.LINE_AA,
                    )
                row_frames.append(disp)
            rows.append(cv2.hconcat(row_frames))

        combined = cv2.vconcat(rows)
        cv2.putText(
            combined,
            "Esc=quit",
            (10, 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

        if SHOW_WINDOW:
            cv2.imshow("RL Grid Traffic Simulator (3x3)", combined)
            # Throttle using current green fps.
            cur_fps = fps.get(green_cell, 30.0)
            delay_ms = max(1, int(round(1000.0 / max(1e-6, cur_fps))))
            key = cv2.waitKey(delay_ms) & 0xFF
            if key == 27 or key == ord("x"):
                break
        else:
            # No window: just run logic.
            elapsed = time.time() - loop_start
            time.sleep(max(0.0, 1.0 / max(1.0, fps.get(green_cell, 30.0))) - elapsed)

    for cap in caps.values():
        cap.release()
    cv2.destroyAllWindows()

    df = pd.DataFrame(decision_records)
    os.makedirs(os.path.dirname(DECISION_LOG_FILE) or ".", exist_ok=True)
    df.to_csv(DECISION_LOG_FILE, index=False)
    print(f"Decisions saved to {DECISION_LOG_FILE}")


if __name__ == "__main__":
    main()

