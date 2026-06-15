"""
main.py  — Smart Traffic Analyzer v2 Orchestrator

Modes (set via config.yaml → system.mode or --mode CLI flag):
  pseudo_live   Run detection service + dashboard server  (default)
  sumo          Run SUMO digital twin simulation
  train         Train all AI components
  predict       Run one prediction cycle and print results
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from utils.config_loader import load_config


def run_pseudo_live(cfg: dict) -> None:
    """Start the pseudo-live detection service (blocks)."""
    script = ROOT / "pseudo_live_detection_service.py"
    python = sys.executable
    env = {**os.environ}
    widths = cfg.get("lanes", {}).get("widths_m", [])
    if widths:
        env["VITE_LANE_WIDTHS"] = ",".join(str(w) for w in widths)
    print("[main] Starting pseudo-live detection service …")
    proc = subprocess.run([python, str(script)], env=env)
    sys.exit(proc.returncode)


def run_sumo(cfg: dict) -> None:
    """Run one SUMO simulation episode and print stats."""
    from simulation.sumo_env import make_sumo_env
    from stable_baselines3 import DQN

    sim_cfg = cfg.get("simulation", {})
    lane_cfg = cfg.get("lanes", {})
    env = make_sumo_env(
        num_lanes=lane_cfg.get("num_lanes", 4),
        lane_widths=lane_cfg.get("widths_m"),
        use_gui=sim_cfg.get("use_gui", False),
        state_json_path=sim_cfg.get("state_json_path"),
    )
    obs, _ = env.reset()
    model_path = cfg.get("control", {}).get("dqn", {}).get("save_path", "dqn_traffic_controller")
    model = None
    if Path(f"{model_path}.zip").exists():
        try:
            model = DQN.load(model_path, env=env)
            print(f"[main] Loaded DQN from {model_path}.zip")
        except Exception as e:
            print(f"[main] Could not load DQN: {e} — using random policy")

    total_reward, steps = 0.0, 0
    while True:
        if model:
            action, _ = model.predict(obs, deterministic=True)
        else:
            action = env.action_space.sample()
        obs, reward, term, trunc, _ = env.step(int(action))
        total_reward += reward
        steps += 1
        if term or trunc:
            break
    env.close()
    print(f"[main] SUMO episode done: steps={steps} total_reward={total_reward:.1f}")


def run_train(cfg: dict) -> None:
    """Train all AI components."""
    from train_rl import train_dqn, train_gnn, train_transformer
    train_dqn(cfg)
    try:
        train_gnn(cfg)
    except Exception as e:
        print(f"[main] GNN skipped: {e}")
    try:
        train_transformer(cfg)
    except Exception as e:
        print(f"[main] Transformer skipped: {e}")


def run_predict(cfg: dict) -> None:
    """Run a single prediction cycle using most recent CSV logs."""
    from prediction.gnn_predictor import GNNTrainer
    import numpy as np

    lane_cfg = cfg.get("lanes", {})
    gnn_cfg = cfg.get("prediction", {}).get("gnn", {})
    t_in = gnn_cfg.get("t_in", 8)
    t_out = gnn_cfg.get("t_out", 3)
    num_lanes = lane_cfg.get("num_lanes", 4)
    widths = lane_cfg.get("widths_m", [3.5] * num_lanes)

    trainer = GNNTrainer(
        csv_dir=cfg.get("system", {}).get("log_dir", "logs"),
        t_in=t_in,
        t_out=t_out,
        lane_widths=widths,
        save_path=gnn_cfg.get("save_path", "gnn_predictor.pth"),
    )
    try:
        model = trainer.load(num_nodes=num_lanes)
    except Exception:
        print("[main] GNN model not found — training first …")
        trainer.train(epochs=20)
        model = trainer.load(num_nodes=num_lanes)

    # Random dummy input for demonstration
    x = np.random.rand(t_in, num_lanes, 4).astype(np.float32)
    pred = trainer.predict(x)
    print(f"[main] GNN prediction (next {t_out} steps):\n{pred}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Smart Traffic Analyzer v2")
    parser.add_argument(
        "--mode",
        choices=["pseudo_live", "sumo", "train", "predict"],
        default=None,
        help="Operation mode (overrides config.yaml system.mode)",
    )
    parser.add_argument("--config", default=None, help="Path to config.yaml")
    args = parser.parse_args()

    cfg = load_config(args.config)
    mode = args.mode or cfg.get("system", {}).get("mode", "pseudo_live")

    print(f"[main] Smart Traffic Analyzer v2 — mode={mode}")

    dispatch = {
        "pseudo_live": run_pseudo_live,
        "sumo": run_sumo,
        "train": run_train,
        "predict": run_predict,
    }
    fn = dispatch.get(mode)
    if fn is None:
        print(f"[main] Unknown mode '{mode}'")
        sys.exit(1)
    fn(cfg)


if __name__ == "__main__":
    main()
