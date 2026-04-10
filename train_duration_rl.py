import os

import numpy as np
from stable_baselines3 import DQN
from stable_baselines3.common.vec_env import DummyVecEnv

from green_duration_env import GreenDurationEnv


MODEL_PATH = "duration_dqn.zip"
TB_LOG_DIR = "tb_logs_duration"


def make_env():
    # Duration range must match what you want in the simulator.
    return GreenDurationEnv(min_sec=40.0, max_sec=90.0, num_buckets=6, density_noise=0.05)


def main():
    os.makedirs(TB_LOG_DIR, exist_ok=True)

    env = DummyVecEnv([make_env])
    model = DQN(
        "MlpPolicy",
        env,
        learning_rate=1e-3,
        buffer_size=50_000,
        learning_starts=1_000,
        batch_size=64,
        gamma=0.99,
        train_freq=4,
        target_update_interval=1_000,
        verbose=1,
        tensorboard_log=TB_LOG_DIR,
    )

    # This is a light training budget; increase if needed.
    model.learn(total_timesteps=150_000)
    model.save(MODEL_PATH.replace(".zip", ""))
    model.save(MODEL_PATH)
    print(f"Saved duration model as {MODEL_PATH}")


if __name__ == "__main__":
    main()

