# full_pipeline_v2.py
import subprocess
import sys
import glob
from stable_baselines3 import DQN
from traffic_env import TrafficReplayEnv

# ---------------- Step 1: Run detection_tracker on all videos ----------------
print("Running detection_tracker on all videos...")
subprocess.run([sys.executable, "detection_tracker.py"], check=True)

# Validate generated CSV logs (schema/length sanity).
print("Validating generated CSV logs...")
subprocess.run([sys.executable, "validate_logs.py"], check=False)

# ---------------- Step 2: Train flow predictor (optional) ----------------
print("Training flow predictor (optional)...")
try:
    subprocess.run([sys.executable, "flow_predictor.py"], check=True)
except FileNotFoundError:
    print("flow_predictor.py not found, skipping this step.")

# ---------------- Step 3: Train RL agent ----------------
print("Training RL agent...")
subprocess.run([sys.executable, "train_rl.py"], check=True)

# Produce baseline-vs-RL evaluation report.
print("Evaluating RL policy vs baseline...")
subprocess.run([sys.executable, "evaluate_policies.py"], check=False)

# ---------------- Step 4: Evaluate RL agent on all CSVs ----------------
print("Evaluating trained RL agent on all CSVs...")

model = DQN.load("dqn_traffic_controller.zip")
csv_files = glob.glob("logs/*_timeseries.csv")

for file in csv_files:
    print(f"\n--- Evaluating {file} ---")
    env = TrafficReplayEnv(
        csv_dir="logs",
        fixed_csv_path=file,
        service_fraction=0.05,
        switch_penalty=0.01,
    )
    obs, info = env.reset(options={"csv_path": file})
    done = False
    step_count = 0
    total_reward = 0.0

    while not done:
        action, _ = model.predict(obs, deterministic=True)
        action = int(action)
        obs, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated

        step_count += 1
        total_reward += float(reward)

        if step_count % 200 == 0 or done:
            print(f"Steps: {step_count} | Pos: {env.pos} | TotalReward: {total_reward:.2f}")

    print(f"Done: steps={step_count}, total_reward={total_reward:.2f}")

print("\nPipeline complete!")
