"""
traffic_env.py  (v2 — Smart Traffic Analyzer)

Width-Aware Safety Traffic Replay Environment
=============================================
Gymnasium environment that replays recorded CSV logs while using the
safety-first reward function from control/reward_fn.py.

Changes from v1
---------------
- Observation extended to (num_lanes × OBS_PER_LANE) — adds congestionNorm
  and laneWidth as features per lane (OBS_PER_LANE = 5)
- Reward uses SafetyRewardFn (queue + collision + pedestrian + speed + emergency)
- lane_widths parameter controls capacity-based congestion
- Compatible with both DQN (single agent) and MAPPO (multi-agent)
"""

from __future__ import annotations

import glob
import random
from typing import List, Optional

import numpy as np
import pandas as pd
from gymnasium import Env, spaces

from traffic_utils import extract_density_matrix, extract_speed_matrix, infer_num_lanes_from_df

try:
    import sys, os
    sys.path.insert(0, os.path.dirname(__file__))
    from control.reward_fn import SafetyRewardFn, RewardComponents
    _HAS_SAFETY_REWARD = True
except ImportError:
    _HAS_SAFETY_REWARD = False

# Observation features per lane
OBS_PER_LANE = 5   # [queue_norm, speed_norm, density_norm, cong_norm, width_norm]
VEHICLES_PER_METER_WIDTH = 2.5
DEFAULT_LANE_WIDTH_M = 3.5


class TrafficReplayEnv(Env):
    """
    Replay environment for RL traffic signal control.

    Observation: (num_lanes × OBS_PER_LANE,) float32
    Action: choose which lane gets green (Discrete)
    Reward: safety-first composite (SafetyRewardFn) or simple queue reward

    Parameters
    ----------
    csv_dir : str
    csv_files : list or None
    fixed_csv_path : str or None
    service_fraction : float
    switch_penalty : float
    arrival_clip : float or None
    lane_widths : list[float] or None
        Physical lane widths in metres.  If None, all lanes default to 3.5 m.
    """
    metadata = {"render.modes": ["human"]}

    def __init__(
        self,
        csv_dir: str = "logs",
        csv_files=None,
        fixed_csv_path: Optional[str] = None,
        service_fraction: float = 0.05,
        switch_penalty: float = 0.01,
        arrival_clip: Optional[float] = None,
        lane_widths: Optional[List[float]] = None,
    ):
        super().__init__()
        self.csv_files = csv_files or glob.glob(csv_dir + "/*_timeseries.csv")
        if not self.csv_files:
            raise AssertionError(f"No time-series CSVs found in '{csv_dir}'")

        # Infer lane count
        inferred = []
        for p in self.csv_files:
            try:
                inferred.append(infer_num_lanes_from_df(pd.read_csv(p)))
            except Exception:
                continue
        if not inferred:
            raise AssertionError("Could not infer lane count from CSVs.")
        self.num_lanes = int(max(inferred))

        # Lane geometry
        self.lane_widths: List[float] = (
            (lane_widths + [DEFAULT_LANE_WIDTH_M] * self.num_lanes)[:self.num_lanes]
            if lane_widths else [DEFAULT_LANE_WIDTH_M] * self.num_lanes
        )
        self.capacities: List[float] = [
            max(1.0, w * VEHICLES_PER_METER_WIDTH) for w in self.lane_widths
        ]

        # Extended observation space: OBS_PER_LANE features per lane
        obs_dim = self.num_lanes * OBS_PER_LANE
        self.observation_space = spaces.Box(low=0.0, high=1.0, shape=(obs_dim,), dtype=np.float32)
        self.action_space = spaces.Discrete(self.num_lanes)

        self.fixed_csv_path = fixed_csv_path
        self.service_fraction = float(service_fraction)
        self.switch_penalty = float(switch_penalty)
        self.arrival_clip = arrival_clip

        # Precompute service capacity
        max_dens = 0.0
        for p in self.csv_files[:10]:
            try:
                df = pd.read_csv(p)
                dens = extract_density_matrix(df, num_lanes=self.num_lanes)
                max_dens = max(max_dens, float(np.max(dens)) if len(dens) else 0.0)
            except Exception:
                continue
        self.service_capacity = max(0.0, self.service_fraction * max(max_dens, 1.0))

        # Safety reward
        self._reward_fn = SafetyRewardFn() if _HAS_SAFETY_REWARD else None

        # State
        self.current_file: Optional[str] = None
        self.df: Optional[pd.DataFrame] = None
        self.pos: int = 0
        self.queue: Optional[np.ndarray] = None
        self._prev_action: Optional[int] = None
        self._dens: Optional[np.ndarray] = None
        self._speeds: Optional[np.ndarray] = None
        self._prev_queue: Optional[np.ndarray] = None

    # ------------------------------------------------------------------
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        path = options.get("csv_path") if options and "csv_path" in options else None
        path = path or self.fixed_csv_path or random.choice(self.csv_files)
        self.current_file = str(path)
        self.df = pd.read_csv(self.current_file)
        self._dens = extract_density_matrix(self.df, num_lanes=self.num_lanes)
        self._speeds = extract_speed_matrix(self.df, num_lanes=self.num_lanes)
        self.pos = 0
        self.queue = self._dens[0].copy().astype(np.float32)
        self._prev_queue = self.queue.copy()
        self._prev_action = None
        return self._build_obs(), {"csv_path": self.current_file, "pos": self.pos}

    def step(self, action):
        lane = int(action)
        dens_now = self._dens[self.pos]
        dens_next = self._dens[min(self.pos + 1, len(self._dens) - 1)]
        speeds_now = self._speeds[self.pos] if self._speeds is not None else np.zeros(self.num_lanes)

        arrivals = np.clip(dens_next - dens_now, 0.0, None)
        if self.arrival_clip is not None:
            arrivals = np.clip(arrivals, 0.0, float(self.arrival_clip))

        service = np.zeros(self.num_lanes, dtype=np.float32)
        if 0 <= lane < self.num_lanes:
            service[lane] = self.service_capacity

        self._prev_queue = self.queue.copy()
        self.queue = np.clip(self.queue + arrivals - service, 0.0, None)

        # Safety-first reward
        if self._reward_fn:
            components = self._reward_fn.compute(
                queues=self.queue.tolist(),
                prev_queues=self._prev_queue.tolist(),
                chosen_lane=lane,
                prev_lane=self._prev_action,
                lane_widths_m=self.lane_widths,
                avg_speeds_kmh=(speeds_now * 3.6).tolist(),
                pedestrian_conflicts=[False] * self.num_lanes,
                emergency_lanes=[False] * self.num_lanes,
            )
            reward = components.total
        else:
            reward = -float(np.sum(self.queue))
            if self._prev_action is not None and lane != self._prev_action:
                reward -= self.switch_penalty

        self._prev_action = lane
        self.pos += 1
        terminated = self.pos >= len(self._dens) - 1
        obs = self._build_obs() if not terminated else np.zeros(self.observation_space.shape, dtype=np.float32)
        info = {
            "csv_path": self.current_file,
            "pos": self.pos,
            "action": lane,
            "queue": self.queue.copy().astype(np.float32),
        }
        return obs, reward, terminated, False, info

    def render(self, mode='human'):
        if self.queue is None:
            print(f"File: {self.current_file} | Pos: {self.pos}")
        else:
            print(f"File: {self.current_file} | Pos: {self.pos} | Queue: {np.round(self.queue, 2)}")

    def close(self):
        pass

    # ------------------------------------------------------------------
    def _build_obs(self) -> np.ndarray:
        """Build extended observation vector (num_lanes × OBS_PER_LANE)."""
        obs = np.zeros(self.num_lanes * OBS_PER_LANE, dtype=np.float32)
        dens_now = self._dens[self.pos] if self._dens is not None else np.zeros(self.num_lanes)
        speeds_now = self._speeds[self.pos] if self._speeds is not None else np.zeros(self.num_lanes)
        max_d = max(1.0, float(dens_now.max()))

        for i in range(self.num_lanes):
            cap = self.capacities[i]
            base = i * OBS_PER_LANE
            q_norm = min(1.0, float(self.queue[i]) / max(1.0, cap))
            s_norm = min(1.0, float(speeds_now[i]) / 100.0)
            d_norm = min(1.0, float(dens_now[i]) / max_d)
            c_norm = min(1.0, float(dens_now[i]) / cap)
            w_norm = self.lane_widths[i] / 10.0
            obs[base:base + OBS_PER_LANE] = [q_norm, s_norm, d_norm, c_norm, w_norm]

        return obs
