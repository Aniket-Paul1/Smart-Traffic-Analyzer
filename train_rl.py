# train_rl.py
import os

from stable_baselines3 import DQN
from stable_baselines3.common.vec_env import DummyVecEnv

from traffic_env import TrafficReplayEnv


os.makedirs("tb_logs", exist_ok=True)


def make_env():
    # service_fraction and switch_penalty directly affect reward dynamics.
    return TrafficReplayEnv(
        csv_dir="logs",
        service_fraction=0.05,
        switch_penalty=0.01,
        arrival_clip=None,
    )


env = DummyVecEnv([make_env])
model = DQN(
    "MlpPolicy",
    env,
    learning_rate=1e-4,
    verbose=1,
    tensorboard_log="./tb_logs/",
)

# NOTE: choose total_timesteps according to compute available.
model.learn(total_timesteps=200_000)
model.save("dqn_traffic_controller")
print("Saved model as dqn_traffic_controller.zip")
