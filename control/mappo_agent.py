"""
control/mappo_agent.py

Multi-Agent PPO (MAPPO) for Traffic Signal Control
===================================================
Each intersection / lane-group is an independent PPO agent sharing
a centralised critic (CTDE – Centralised Training, Decentralised Execution).

Architecture
------------
Actor  : MLP  obs → action_logits  (per agent, decentralised)
Critic : MLP  global_obs → value   (centralised, shared)

Training loop implements the standard PPO clipped objective with:
- Generalised Advantage Estimation (GAE)
- Entropy bonus for exploration
- Value function loss coefficient
- Safety-first reward (imported from reward_fn)

Compatible with the existing TrafficReplayEnv (single intersection)
and extensible to SUMO multi-intersection environments.

Usage
-----
    from control.mappo_agent import MAPPOAgent, MAPPOTrainer

    agents = [MAPPOAgent(obs_dim=5, act_dim=4) for _ in range(num_intersections)]
    trainer = MAPPOTrainer(agents, env)
    trainer.train(epochs=200)
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions import Categorical


# ---------------------------------------------------------------------------
# Actor and Critic networks
# ---------------------------------------------------------------------------

class Actor(nn.Module):
    """Per-agent policy network: obs → action logits."""

    def __init__(self, obs_dim: int, act_dim: int, hidden: int = 128) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
            nn.Linear(hidden, act_dim),
        )

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.net(obs)   # logits

    def get_dist(self, obs: torch.Tensor) -> Categorical:
        return Categorical(logits=self.forward(obs))


class CentralCritic(nn.Module):
    """Shared centralised critic: global_obs → value."""

    def __init__(self, global_obs_dim: int, hidden: int = 256) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(global_obs_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
            nn.Linear(hidden, 1),
        )

    def forward(self, global_obs: torch.Tensor) -> torch.Tensor:
        return self.net(global_obs).squeeze(-1)


# ---------------------------------------------------------------------------
# Single agent wrapper
# ---------------------------------------------------------------------------

class MAPPOAgent:
    """
    One PPO agent controlling one intersection / lane-group.

    Parameters
    ----------
    obs_dim : int           Local observation size.
    act_dim : int           Number of actions (lanes to select).
    hidden : int            Actor hidden size.
    device : str
    """

    def __init__(
        self,
        obs_dim: int,
        act_dim: int,
        hidden: int = 128,
        device: str = "cpu",
    ) -> None:
        self.device = torch.device(device)
        self.actor = Actor(obs_dim, act_dim, hidden).to(self.device)
        self.obs_dim = obs_dim
        self.act_dim = act_dim

    def select_action(
        self, obs: np.ndarray, deterministic: bool = False
    ) -> Tuple[int, float]:
        """
        Returns (action, log_prob).
        """
        t = torch.from_numpy(obs).float().to(self.device)
        dist = self.actor.get_dist(t)
        if deterministic:
            action = dist.probs.argmax().item()
            log_prob = dist.log_prob(torch.tensor(action, device=self.device)).item()
        else:
            action_t = dist.sample()
            log_prob = dist.log_prob(action_t).item()
            action = action_t.item()
        return int(action), float(log_prob)

    def save(self, path: str) -> None:
        torch.save(self.actor.state_dict(), path)

    def load(self, path: str) -> None:
        self.actor.load_state_dict(torch.load(path, map_location=self.device))
        self.actor.eval()


# ---------------------------------------------------------------------------
# Rollout buffer
# ---------------------------------------------------------------------------

@dataclasses.dataclass if False else type("_", (), {})  # avoid import for dataclass
class RolloutBuffer:
    def __init__(self) -> None:
        self.obs: List[np.ndarray] = []
        self.global_obs: List[np.ndarray] = []
        self.actions: List[int] = []
        self.log_probs: List[float] = []
        self.rewards: List[float] = []
        self.dones: List[bool] = []
        self.values: List[float] = []

    def add(
        self,
        obs: np.ndarray,
        global_obs: np.ndarray,
        action: int,
        log_prob: float,
        reward: float,
        done: bool,
        value: float,
    ) -> None:
        self.obs.append(obs)
        self.global_obs.append(global_obs)
        self.actions.append(action)
        self.log_probs.append(log_prob)
        self.rewards.append(reward)
        self.dones.append(done)
        self.values.append(value)

    def compute_returns_and_advantages(
        self, last_value: float, gamma: float = 0.99, lam: float = 0.95
    ) -> Tuple[np.ndarray, np.ndarray]:
        """GAE-Lambda advantage estimation."""
        T = len(self.rewards)
        adv = np.zeros(T, dtype=np.float32)
        ret = np.zeros(T, dtype=np.float32)
        gae = 0.0
        for t in reversed(range(T)):
            next_val = last_value if t == T - 1 else self.values[t + 1]
            mask = 0.0 if self.dones[t] else 1.0
            delta = self.rewards[t] + gamma * next_val * mask - self.values[t]
            gae = delta + gamma * lam * mask * gae
            adv[t] = gae
        ret = adv + np.array(self.values, dtype=np.float32)
        # Normalise advantages
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        return ret, adv

    def clear(self) -> None:
        self.__init__()


# ---------------------------------------------------------------------------
# MAPPO Trainer
# ---------------------------------------------------------------------------

class MAPPOTrainer:
    """
    Centralised-training / decentralised-execution PPO trainer.

    Parameters
    ----------
    agents : list of MAPPOAgent
    envs : list of gym-compatible environments (one per agent, or shared)
    global_obs_dim : int   Size of concatenated global observation.
    lr_actor : float
    lr_critic : float
    gamma : float
    lam : float            GAE lambda
    clip_eps : float       PPO clip epsilon
    entropy_coef : float
    vf_coef : float
    n_steps : int          Rollout length before update
    n_epochs : int         PPO update epochs per rollout
    device : str
    save_dir : str
    """

    def __init__(
        self,
        agents: List[MAPPOAgent],
        envs,                       # list of envs or single env
        global_obs_dim: Optional[int] = None,
        lr_actor: float = 3e-4,
        lr_critic: float = 1e-3,
        gamma: float = 0.99,
        lam: float = 0.95,
        clip_eps: float = 0.2,
        entropy_coef: float = 0.01,
        vf_coef: float = 0.5,
        n_steps: int = 512,
        n_epochs: int = 10,
        device: str = "cpu",
        save_dir: str = "mappo_checkpoints",
    ) -> None:
        self.agents = agents
        self.envs = envs if isinstance(envs, list) else [envs] * len(agents)
        self.n_agents = len(agents)
        self.gamma = gamma
        self.lam = lam
        self.clip_eps = clip_eps
        self.entropy_coef = entropy_coef
        self.vf_coef = vf_coef
        self.n_steps = n_steps
        self.n_epochs = n_epochs
        self.device = torch.device(device)
        self.save_dir = save_dir
        os.makedirs(save_dir, exist_ok=True)

        # Infer global obs dim if not given
        _obs_dim = agents[0].obs_dim
        self.global_obs_dim = global_obs_dim or (_obs_dim * self.n_agents)

        self.critic = CentralCritic(self.global_obs_dim).to(self.device)
        self.actor_optimizers = [
            optim.Adam(ag.actor.parameters(), lr=lr_actor)
            for ag in agents
        ]
        self.critic_optimizer = optim.Adam(self.critic.parameters(), lr=lr_critic)

        self.buffers = [RolloutBuffer() for _ in range(self.n_agents)]

    # ------------------------------------------------------------------
    def train(self, total_epochs: int = 200) -> Dict:
        """Main training loop. Returns history dict."""
        history = {"epoch": [], "mean_reward": [], "safety_score": []}

        for epoch in range(1, total_epochs + 1):
            # Collect rollouts
            obs_list = [env.reset()[0] for env in self.envs]
            epoch_rewards = []

            for _ in range(self.n_steps):
                global_obs = np.concatenate([
                    np.pad(obs, (0, max(0, self.agents[i].obs_dim - len(obs))))
                    for i, obs in enumerate(obs_list)
                ], axis=0).astype(np.float32)

                global_t = torch.from_numpy(global_obs).float().to(self.device)
                with torch.no_grad():
                    value = self.critic(global_t).item()

                actions, log_probs = [], []
                for i, ag in enumerate(self.agents):
                    a, lp = ag.select_action(obs_list[i])
                    actions.append(a)
                    log_probs.append(lp)

                rewards, dones, next_obs_list = [], [], []
                for i, env in enumerate(self.envs):
                    obs_n, rew, term, trunc, _ = env.step(actions[i])
                    rewards.append(float(rew))
                    dones.append(term or trunc)
                    next_obs_list.append(obs_n if not (term or trunc) else env.reset()[0])

                mean_reward = float(np.mean(rewards))
                epoch_rewards.append(mean_reward)

                for i in range(self.n_agents):
                    self.buffers[i].add(
                        obs_list[i], global_obs, actions[i],
                        log_probs[i], rewards[i], dones[i], value,
                    )

                obs_list = next_obs_list

            # Compute last value for bootstrapping
            global_obs_last = np.concatenate([
                np.pad(obs, (0, max(0, self.agents[i].obs_dim - len(obs))))
                for i, obs in enumerate(obs_list)
            ], axis=0).astype(np.float32)
            with torch.no_grad():
                last_val = self.critic(
                    torch.from_numpy(global_obs_last).float().to(self.device)
                ).item()

            # Compute advantages and update
            for i in range(self.n_agents):
                returns, adv = self.buffers[i].compute_returns_and_advantages(last_val, self.gamma, self.lam)
                self._update_agent(i, returns, adv)
                self.buffers[i].clear()

            mean_ep_rew = float(np.mean(epoch_rewards))
            history["epoch"].append(epoch)
            history["mean_reward"].append(round(mean_ep_rew, 4))
            history["safety_score"].append(max(0, 100 + int(mean_ep_rew)))

            if epoch % 20 == 0 or epoch == 1:
                print(f"[MAPPO] Epoch {epoch}/{total_epochs}  mean_reward={mean_ep_rew:.3f}")
                self._save(epoch)

        return history

    def _update_agent(
        self,
        agent_idx: int,
        returns: np.ndarray,
        advantages: np.ndarray,
    ) -> None:
        buf = self.buffers[agent_idx]
        ag = self.agents[agent_idx]
        actor_opt = self.actor_optimizers[agent_idx]

        obs_t = torch.from_numpy(np.array(buf.obs, dtype=np.float32)).to(self.device)
        gobs_t = torch.from_numpy(np.array(buf.global_obs, dtype=np.float32)).to(self.device)
        acts_t = torch.tensor(buf.actions, dtype=torch.long, device=self.device)
        old_lp_t = torch.tensor(buf.log_probs, dtype=torch.float32, device=self.device)
        ret_t = torch.from_numpy(returns).to(self.device)
        adv_t = torch.from_numpy(advantages).to(self.device)

        for _ in range(self.n_epochs):
            dist = ag.actor.get_dist(obs_t)
            new_lp = dist.log_prob(acts_t)
            entropy = dist.entropy().mean()

            ratio = (new_lp - old_lp_t).exp()
            surr1 = ratio * adv_t
            surr2 = torch.clamp(ratio, 1 - self.clip_eps, 1 + self.clip_eps) * adv_t
            actor_loss = -torch.min(surr1, surr2).mean() - self.entropy_coef * entropy

            values = self.critic(gobs_t)
            critic_loss = nn.functional.mse_loss(values, ret_t)

            loss = actor_loss + self.vf_coef * critic_loss

            actor_opt.zero_grad()
            self.critic_optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(ag.actor.parameters(), 0.5)
            nn.utils.clip_grad_norm_(self.critic.parameters(), 0.5)
            actor_opt.step()
            self.critic_optimizer.step()

    def _save(self, epoch: int) -> None:
        for i, ag in enumerate(self.agents):
            ag.save(os.path.join(self.save_dir, f"agent_{i}_ep{epoch}.pth"))
        torch.save(
            self.critic.state_dict(),
            os.path.join(self.save_dir, f"critic_ep{epoch}.pth"),
        )


import dataclasses  # noqa: E402 (placed after class definitions intentionally)
