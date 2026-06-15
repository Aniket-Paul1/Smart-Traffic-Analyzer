"""
train_rl.py  (v2 — Smart Traffic Analyzer)

Unified RL Training Script
===========================
Supports:
  python train_rl.py --agent dqn        (single-intersection DQN, default)
  python train_rl.py --agent mappo       (multi-agent PPO)
  python train_rl.py --agent gnn        (train GNN predictor only)
  python train_rl.py --agent transformer (train Transformer predictor only)
  python train_rl.py --agent all        (all of the above)

All settings are read from config/config.yaml (or environment overrides).
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from utils.config_loader import load_config


def train_dqn(cfg: dict) -> None:
    from stable_baselines3 import DQN
    from stable_baselines3.common.vec_env import DummyVecEnv
    from traffic_env import TrafficReplayEnv

    dqn_cfg = cfg.get("control", {}).get("dqn", {})
    lane_cfg = cfg.get("lanes", {})
    lane_widths = lane_cfg.get("widths_m") or [3.5] * lane_cfg.get("num_lanes", 4)

    os.makedirs("tb_logs", exist_ok=True)
    os.makedirs("checkpoints", exist_ok=True)

    def make_env():
        return TrafficReplayEnv(
            csv_dir=cfg.get("system", {}).get("log_dir", "logs"),
            service_fraction=dqn_cfg.get("service_fraction", 0.05),
            switch_penalty=dqn_cfg.get("switch_penalty", 0.01),
            lane_widths=lane_widths,
        )

    env = DummyVecEnv([make_env])
    model = DQN(
        "MlpPolicy",
        env,
        learning_rate=dqn_cfg.get("learning_rate", 1e-4),
        verbose=1,
        tensorboard_log=dqn_cfg.get("tensorboard_log", "./tb_logs/"),
    )
    total_timesteps = dqn_cfg.get("total_timesteps", 200_000)
    print(f"[DQN] Training for {total_timesteps:,} timesteps …")
    model.learn(total_timesteps=total_timesteps)
    save_path = dqn_cfg.get("save_path", "dqn_traffic_controller")
    model.save(save_path)
    print(f"[DQN] Saved → {save_path}.zip")


def train_mappo(cfg: dict) -> None:
    from simulation.sumo_env import make_sumo_env
    from control.mappo_agent import MAPPOAgent, MAPPOTrainer

    mappo_cfg = cfg.get("control", {}).get("mappo", {})
    lane_cfg = cfg.get("lanes", {})
    n_agents = mappo_cfg.get("n_agents", 1)
    num_lanes = lane_cfg.get("num_lanes", 4)
    lane_widths = lane_cfg.get("widths_m") or [3.5] * num_lanes

    # obs_dim = num_lanes × OBS_PER_LANE (5)
    obs_dim = num_lanes * 5

    envs = [
        make_sumo_env(
            num_lanes=num_lanes,
            lane_widths=lane_widths,
        )
        for _ in range(n_agents)
    ]

    agents = [
        MAPPOAgent(
            obs_dim=obs_dim,
            act_dim=num_lanes,
            hidden=mappo_cfg.get("hidden", 128),
        )
        for _ in range(n_agents)
    ]

    trainer = MAPPOTrainer(
        agents=agents,
        envs=envs,
        lr_actor=mappo_cfg.get("lr_actor", 3e-4),
        lr_critic=mappo_cfg.get("lr_critic", 1e-3),
        gamma=mappo_cfg.get("gamma", 0.99),
        lam=mappo_cfg.get("lam", 0.95),
        clip_eps=mappo_cfg.get("clip_eps", 0.2),
        entropy_coef=mappo_cfg.get("entropy_coef", 0.01),
        n_steps=mappo_cfg.get("n_steps", 512),
        n_epochs=mappo_cfg.get("n_epochs", 10),
        save_dir=mappo_cfg.get("save_dir", "mappo_checkpoints"),
    )
    total_epochs = mappo_cfg.get("total_epochs", 200)
    print(f"[MAPPO] Training {n_agents} agent(s) for {total_epochs} epochs …")
    history = trainer.train(total_epochs=total_epochs)
    print(f"[MAPPO] Done. Final mean reward: {history['mean_reward'][-1]:.3f}")


def train_gnn(cfg: dict) -> None:
    from prediction.gnn_predictor import GNNTrainer

    pred_cfg = cfg.get("prediction", {}).get("gnn", {})
    lane_cfg = cfg.get("lanes", {})
    trainer = GNNTrainer(
        csv_dir=cfg.get("system", {}).get("log_dir", "logs"),
        t_in=pred_cfg.get("t_in", 8),
        t_out=pred_cfg.get("t_out", 3),
        hidden=pred_cfg.get("hidden", 32),
        lr=pred_cfg.get("lr", 1e-3),
        batch_size=pred_cfg.get("batch_size", 32),
        save_path=pred_cfg.get("save_path", "gnn_predictor.pth"),
        lane_widths=lane_cfg.get("widths_m"),
    )
    print(f"[GNN] Training for {pred_cfg.get('epochs', 50)} epochs …")
    trainer.train(epochs=pred_cfg.get("epochs", 50))


def train_transformer(cfg: dict) -> None:
    from prediction.transformer_predictor import TransformerTrainer

    pred_cfg = cfg.get("prediction", {}).get("transformer", {})
    lane_cfg = cfg.get("lanes", {})
    trainer = TransformerTrainer(
        csv_dir=cfg.get("system", {}).get("log_dir", "logs"),
        t_in=pred_cfg.get("t_in", 16),
        t_out=pred_cfg.get("t_out", 6),
        d_model=pred_cfg.get("d_model", 64),
        n_heads=pred_cfg.get("n_heads", 4),
        n_layers=pred_cfg.get("n_layers", 2),
        lr=pred_cfg.get("lr", 1e-3),
        batch_size=pred_cfg.get("batch_size", 32),
        save_path=pred_cfg.get("save_path", "transformer_predictor.pth"),
        lane_widths=lane_cfg.get("widths_m"),
    )
    print(f"[Transformer] Training for {pred_cfg.get('epochs', 50)} epochs …")
    trainer.train(epochs=pred_cfg.get("epochs", 50))


def main() -> None:
    parser = argparse.ArgumentParser(description="Smart Traffic Analyzer v2 — RL / Predictor Training")
    parser.add_argument(
        "--agent",
        choices=["dqn", "mappo", "gnn", "transformer", "all"],
        default="dqn",
        help="Which component to train (default: dqn)",
    )
    parser.add_argument("--config", default=None, help="Path to config.yaml (optional)")
    args = parser.parse_args()

    cfg = load_config(args.config)
    agent = args.agent

    if agent in ("dqn", "all"):
        train_dqn(cfg)
    if agent in ("gnn", "all"):
        try:
            train_gnn(cfg)
        except Exception as e:
            print(f"[GNN] Skipped (no CSV logs?): {e}")
    if agent in ("transformer", "all"):
        try:
            train_transformer(cfg)
        except Exception as e:
            print(f"[Transformer] Skipped (no CSV logs?): {e}")
    if agent in ("mappo", "all"):
        train_mappo(cfg)


if __name__ == "__main__":
    main()
