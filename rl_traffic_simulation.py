import glob
import os

import cv2
import numpy as np
import pandas as pd
from stable_baselines3 import DQN

from traffic_env import TrafficReplayEnv

if __name__ == "__main__":
    from rl_grid_traffic_simulation import main as _grid_main

    _grid_main()
    raise SystemExit(0)


# ---------------- CONFIG ----------------
VIDEO_FOLDER = "videos"
CSV_FOLDER = "logs"
DECISION_LOG_FILE = "logs/rl_decisions.csv"
FRAME_RATE_FALLBACK = 30
SHOW_WINDOW = True

MODEL_PATHS = [
    "dqn_traffic_controller.zip",
    "dqn_traffic_controller",
]

# Must match training defaults.
ENV_SERVICE_FRACTION = 0.05
ENV_SWITCH_PENALTY = 0.01


def build_lane_positions(num_lanes: int, width: int, y: int = 60):
    """
    Build simple evenly spaced positions for lane indicators.
    """
    margin = int(width * 0.05)
    usable = max(1, width - 2 * margin)
    if num_lanes <= 1:
        xs = [margin + usable // 2]
    else:
        step = usable // (num_lanes - 1)
        xs = [margin + i * step for i in range(num_lanes)]
    return [(x, y) for x in xs]


def load_model():
    for p in MODEL_PATHS:
        try:
            return DQN.load(p), True
        except Exception:
            continue
    print("RL agent not found. Falling back to baseline (argmax queue).")
    return None, False


def get_expected_obs_n_lanes(model: DQN) -> int:
    """
    Introspects the loaded model to find the expected observation size.
    Stable-Baselines3 stores the observation_space in the policy.
    """
    # DQN.policy.observation_space should be a Box(shape=(n_obs,))
    try:
        shp = model.policy.observation_space.shape
        if hasattr(shp, "__len__") and len(shp) >= 1:
            return int(shp[0])
    except Exception:
        pass

    # Fallback: try model.observation_space
    try:
        shp = model.observation_space.shape
        if hasattr(shp, "__len__") and len(shp) >= 1:
            return int(shp[0])
    except Exception:
        pass

    raise RuntimeError("Could not determine expected observation shape from the RL model.")


def adapt_obs_to_expected_lanes(obs: np.ndarray, expected_n_lanes: int) -> np.ndarray:
    obs = np.asarray(obs, dtype=np.float32).reshape(-1)
    n = int(obs.shape[0])
    if n == expected_n_lanes:
        return obs
    if n < expected_n_lanes:
        padded = np.zeros((expected_n_lanes,), dtype=np.float32)
        padded[:n] = obs
        return padded
    return obs[:expected_n_lanes]


video_files = sorted(glob.glob(os.path.join(VIDEO_FOLDER, "*.mp4")))
if not video_files:
    raise FileNotFoundError(f"No .mp4 videos found in {VIDEO_FOLDER}")

model, use_rl = load_model()
expected_n_lanes = None
if use_rl and model is not None:
    expected_n_lanes = get_expected_obs_n_lanes(model)

decision_records = []

for video_path in video_files:
    base = os.path.splitext(os.path.basename(video_path))[0]
    csv_path = os.path.join(CSV_FOLDER, f"{base}_timeseries.csv")
    if not os.path.exists(csv_path):
        print(f" CSV for {base} not found, skipping.")
        continue

    env = TrafficReplayEnv(
        csv_dir=CSV_FOLDER,
        fixed_csv_path=csv_path,
        service_fraction=ENV_SERVICE_FRACTION,
        switch_penalty=ENV_SWITCH_PENALTY,
    )
    obs, _ = env.reset(options={"csv_path": csv_path})
    if expected_n_lanes is not None:
        obs = adapt_obs_to_expected_lanes(obs, expected_n_lanes)

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or FRAME_RATE_FALLBACK
    delay_ms = max(1, int(1000 / fps))

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    lane_positions = build_lane_positions(env.num_lanes, width=width, y=60)

    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        action = 0
        if use_rl and model is not None:
            action_arr, _ = model.predict(obs, deterministic=True)
            action = int(action_arr)
        else:
            # Baseline policy: pick lane with maximum queue.
            action = int(np.argmax(obs))

        # Map action back into the environment's lane index range.
        if env.num_lanes > 0:
            action = int(action) % env.num_lanes

        obs, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated
        if expected_n_lanes is not None:
            obs = adapt_obs_to_expected_lanes(obs, expected_n_lanes)

        # Visualize lane signal for the chosen lane.
        for lane_id, (x, y) in enumerate(lane_positions):
            color = (0, 255, 0) if lane_id == action else (0, 0, 255)
            cv2.circle(frame, (x, y), 28, color, -1)
            cv2.putText(
                frame,
                f"L{lane_id}",
                (x - 22, y + 45),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (255, 255, 255),
                1,
            )

        queue = info.get("queue", np.zeros(env.num_lanes, dtype=np.float32))
        queue_total = float(np.sum(queue))
        queue_lane = float(queue[action]) if env.num_lanes > 0 else 0.0

        cv2.putText(
            frame,
            f"Action: Lane {action} | Queue: {queue_total:.2f} | LaneQ: {queue_lane:.2f}",
            (20, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
        )
        cv2.putText(
            frame,
            f"Reward: {reward:.2f}",
            (20, 55),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 255),
            2,
        )

        decision_records.append(
            {
                "video": base,
                "frame": frame_idx,
                "csv_path": csv_path,
                "chosen_lane": action,
                "queue_total": queue_total,
                "queue_lane": queue_lane,
                "reward": float(reward),
            }
        )

        if SHOW_WINDOW:
            cv2.imshow("RL Traffic Simulator", frame)
            if cv2.waitKey(delay_ms) & 0xFF == ord("q"):
                break

        frame_idx += 1
        if done:
            break

    cap.release()

cv2.destroyAllWindows()

df_log = pd.DataFrame(decision_records)
df_log.to_csv(DECISION_LOG_FILE, index=False)
print(f"Decisions saved to {DECISION_LOG_FILE}")
