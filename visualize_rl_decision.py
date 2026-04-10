# visualize_rl_decision.py
import cv2, os, glob
import numpy as np
import pandas as pd
from stable_baselines3 import DQN
from traffic_env import TrafficReplayEnv

# ---------------- CONFIG ----------------
VIDEO_FOLDER = "videos"
LOG_FOLDER = "logs"
OUTPUT_FOLDER = "demo_videos"

os.makedirs(OUTPUT_FOLDER, exist_ok=True)


def build_lane_positions(num_lanes: int, width: int, y: int = 60):
    """
    Build simple evenly spaced positions for lane indicators.
    """
    # Choose x spread based on video width; keep inside bounds.
    margin = int(width * 0.05)
    usable = max(1, width - 2 * margin)
    if num_lanes <= 1:
        xs = [margin + usable // 2]
    else:
        step = usable // (num_lanes - 1)
        xs = [margin + i * step for i in range(num_lanes)]
    return [(x, y) for x in xs]

# ---------------- LOAD MODEL ----------------
print("Loading trained RL agent...")
model = DQN.load("dqn_traffic_controller.zip")


def get_expected_obs_n_lanes(model: DQN) -> int:
    try:
        shp = model.policy.observation_space.shape
        if hasattr(shp, "__len__") and len(shp) >= 1:
            return int(shp[0])
    except Exception:
        pass
    try:
        shp = model.observation_space.shape
        if hasattr(shp, "__len__") and len(shp) >= 1:
            return int(shp[0])
    except Exception:
        pass
    raise RuntimeError("Could not infer expected observation size from model.")


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


expected_n_lanes = get_expected_obs_n_lanes(model)

# ---------------- GET VIDEO & CSV PAIRS ----------------
video_files = sorted(glob.glob(os.path.join(VIDEO_FOLDER, "*.mp4")))
if not video_files:
    raise FileNotFoundError(f"No .mp4 videos found in {VIDEO_FOLDER}")

for video_path in video_files:
    base = os.path.splitext(os.path.basename(video_path))[0]
    csv_path = os.path.join(LOG_FOLDER, f"{base}_timeseries.csv")

    if not os.path.exists(csv_path):
        print(f" CSV for {base} not found, skipping.")
        continue

    print(f"\n Visualizing agent decisions for {base}...")

    # Initialize environment with the same CSV data
    env = TrafficReplayEnv(csv_dir=LOG_FOLDER)
    obs, info = env.reset(options={"csv_path": csv_path})
    done = False

    # Setup video I/O
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    out_path = os.path.join(OUTPUT_FOLDER, f"{base}_ai_controlled.mp4")
    out = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*'mp4v'), fps, (width, height))

    frame_idx = 0

    cv2.namedWindow("AI Traffic Control", cv2.WINDOW_NORMAL)
    cv2.resizeWindow("AI Traffic Control", 960, 540)

    lane_positions = build_lane_positions(env.num_lanes, width=width, y=60)

    while True:
        ret, frame = cap.read()
        if not ret or done:
            break

        # Get agent decision
        obs_for_model = adapt_obs_to_expected_lanes(obs, expected_n_lanes)
        action, _ = model.predict(obs_for_model, deterministic=True)
        action = int(action)
        # Map action back into environment lane index range.
        if env.num_lanes > 0:
            action = action % env.num_lanes
        obs, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated

        # Draw lane signals (Green = selected lane, Red = others)
        for lane_id, (x, y) in enumerate(lane_positions):
            color = (0, 255, 0) if lane_id == action else (0, 0, 255)
            cv2.circle(frame, (x, y), 40, color, -1)
            cv2.putText(frame, f"Lane {lane_id}", (x - 50, y + 80),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

        # Add density overlay
        if info and "recorded_density_now" in info:
            dens = info.get("recorded_density_now", np.zeros(env.num_lanes, dtype=np.float32))
            text = " | ".join([f"L{i}:{float(d):.1f}" for i, d in enumerate(dens)])
            cv2.putText(frame, f"Recorded density: {text}", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)

        # Add decision text
        cv2.putText(frame, f"Agent Decision: Lane {action} → GREEN",
                    (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 3)

        # Write to output and display
        out.write(frame)
        cv2.imshow("AI Traffic Control", frame)

        # Press Q to exit early
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

        frame_idx += 1

    cap.release()
    out.release()
    print(f" Saved visualization video: {out_path}")

cv2.destroyAllWindows()
print("\n All videos visualized successfully!")
