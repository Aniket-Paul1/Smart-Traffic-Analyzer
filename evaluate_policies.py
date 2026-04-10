import glob
import os
from typing import Optional, Tuple

import numpy as np
import pandas as pd
from stable_baselines3 import DQN

from traffic_env import TrafficReplayEnv


LOG_DIR = "logs"
CSV_PATTERN = os.path.join(LOG_DIR, "*_timeseries.csv")

MODEL_PATH = "dqn_traffic_controller.zip"

# Must match training defaults.
ENV_SERVICE_FRACTION = 0.05
ENV_SWITCH_PENALTY = 0.01


def load_model(model_path: str) -> Optional[DQN]:
    try:
        if os.path.exists(model_path):
            return DQN.load(model_path)
        # fallback: stable-baselines may save without .zip
        if os.path.exists(model_path.replace(".zip", "")):
            return DQN.load(model_path.replace(".zip", ""))
    except Exception:
        return None
    return None


def run_policy(env: TrafficReplayEnv, policy_type: str, model: Optional[DQN] = None) -> Tuple[int, float, float, float, int]:
    """
    Returns:
      steps, total_reward, avg_queue_total, avg_queue_std, switches
    """
    obs, _ = env.reset()
    done = False
    steps = 0
    total_reward = 0.0
    queue_totals = []
    queue_stds = []
    last_action = None
    switches = 0

    while not done:
        if policy_type == "rl":
            action_arr, _ = model.predict(obs, deterministic=True)
            action = int(action_arr)
        elif policy_type == "baseline_argmax_queue":
            action = int(np.argmax(obs))
        else:
            raise ValueError(f"Unknown policy_type: {policy_type}")

        obs, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated

        steps += 1
        total_reward += float(reward)

        queue = info.get("queue", np.array(obs, dtype=np.float32))
        queue_totals.append(float(np.sum(queue)))
        queue_stds.append(float(np.std(queue)))

        if last_action is not None and action != last_action:
            switches += 1
        last_action = action

        if done:
            break

    avg_queue_total = float(np.mean(queue_totals)) if queue_totals else 0.0
    avg_queue_std = float(np.mean(queue_stds)) if queue_stds else 0.0
    return steps, total_reward, avg_queue_total, avg_queue_std, switches


def main():
    csv_files = sorted(glob.glob(CSV_PATTERN))
    if not csv_files:
        raise FileNotFoundError(f"No CSVs found with pattern: {CSV_PATTERN}")

    model = load_model(MODEL_PATH)
    if model is None:
        print(f"Model not found at '{MODEL_PATH}'. RL policy evaluation will be skipped.")

    rows = []
    for csv_path in csv_files:
        for policy_type in ["baseline_argmax_queue", "rl"]:
            if policy_type == "rl" and model is None:
                continue
            env = TrafficReplayEnv(
                csv_dir=LOG_DIR,
                fixed_csv_path=csv_path,
                service_fraction=ENV_SERVICE_FRACTION,
                switch_penalty=ENV_SWITCH_PENALTY,
            )
            steps, total_reward, avg_queue_total, avg_queue_std, switches = run_policy(
                env, policy_type=policy_type, model=model
            )
            rows.append(
                {
                    "csv_path": csv_path,
                    "policy": policy_type,
                    "steps": steps,
                    "total_reward": total_reward,
                    "avg_queue_total": avg_queue_total,
                    "avg_queue_std": avg_queue_std,
                    "switches": switches,
                }
            )

    report = pd.DataFrame(rows)
    out_path = os.path.join(LOG_DIR, "policy_evaluation_report.csv")
    report.to_csv(out_path, index=False)
    print(f"Saved policy evaluation report: {out_path}")

    # Print a compact summary grouped by policy.
    if not report.empty:
        print("\nSummary (mean over CSVs):")
        summary = (
            report.groupby("policy")
            .agg(
                mean_total_reward=("total_reward", "mean"),
                mean_avg_queue_total=("avg_queue_total", "mean"),
                mean_avg_queue_std=("avg_queue_std", "mean"),
                mean_switches=("switches", "mean"),
            )
            .reset_index()
        )
        print(summary.to_string(index=False))


if __name__ == "__main__":
    main()

