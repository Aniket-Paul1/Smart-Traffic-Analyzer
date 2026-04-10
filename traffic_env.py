from gymnasium import Env, spaces
import numpy as np
import pandas as pd
import glob, random
from typing import Optional

from traffic_utils import (
    extract_density_matrix,
    extract_speed_matrix,
    infer_num_lanes_from_df,
)

class TrafficReplayEnv(Env):
    """
    Replay environment for RL traffic control.
    Observation: queue estimate per lane (float32, shape=(num_lanes,))
    Action: choose which lane gets service/green for this step
    Reward: negative total queue + (optional) switching penalty

    Notes on dynamics:
    - Densities are replayed from recorded CSV logs.
    - We interpret positive density increases as arrivals.
    - We interpret a fixed service capacity applied to the chosen lane each step.
    """
    metadata = {"render.modes": ["human"]}

    def __init__(
        self,
        csv_dir: str = "logs",
        csv_files=None,
        fixed_csv_path: Optional[str] = None,
        service_fraction: float = 0.05,
        switch_penalty: float = 0.0,
        arrival_clip: Optional[float] = None,
    ):
        super().__init__()
        self.csv_files = csv_files or glob.glob(csv_dir + "/*_timeseries.csv")
        if not self.csv_files:
            raise AssertionError(f"No time series CSVs found in '{csv_dir}'")

        # Infer lane count across the whole dataset so the action space doesn't shrink
        # when the first CSV happens to be legacy single-lane format.
        inferred_lanes = []
        for p in self.csv_files:
            try:
                df = pd.read_csv(p)
                inferred_lanes.append(infer_num_lanes_from_df(df))
            except Exception:
                continue
        if not inferred_lanes:
            raise AssertionError("Could not infer lane count from CSVs.")
        self.num_lanes = int(max(inferred_lanes))
        self.observation_space = spaces.Box(
            low=0.0, high=np.inf, shape=(self.num_lanes,), dtype=np.float32
        )
        self.action_space = spaces.Discrete(self.num_lanes)

        self.fixed_csv_path = fixed_csv_path
        self.service_fraction = float(service_fraction)
        self.switch_penalty = float(switch_penalty)
        self.arrival_clip = arrival_clip

        self.current_file = None
        self.df = None
        self.pos = 0
        self.queue = None
        self._prev_action = None
        self._dens = None

        # Precompute a reasonable service capacity from the dataset.
        max_dens = 0.0
        for p in self.csv_files[:10]:  # cap work; we only need an order-of-magnitude scale
            try:
                df = pd.read_csv(p)
                dens = extract_density_matrix(df, num_lanes=self.num_lanes)
                max_dens = max(max_dens, float(np.max(dens)) if len(dens) else 0.0)
            except Exception:
                continue
        if max_dens <= 0:
            max_dens = 1.0
        self.service_capacity = max(0.0, self.service_fraction * max_dens)

    def _select_csv_path(self, options=None) -> str:
        if options and "csv_path" in options and options["csv_path"]:
            return str(options["csv_path"])
        if self.fixed_csv_path:
            return str(self.fixed_csv_path)
        return random.choice(self.csv_files)

    def step(self, action):
        lane = int(action)
        terminated = False
        truncated = False

        # Current and next density snapshots from replay log.
        dens_now = self._dens[self.pos]  # (num_lanes,)
        dens_next = self._dens[min(self.pos + 1, len(self._dens) - 1)]

        # Arrivals are modeled as positive changes in recorded densities.
        arrivals = dens_next - dens_now
        arrivals = np.clip(arrivals, 0.0, None)
        if self.arrival_clip is not None:
            arrivals = np.clip(arrivals, 0.0, float(self.arrival_clip))

        service_vec = np.zeros(self.num_lanes, dtype=np.float32)
        if 0 <= lane < self.num_lanes:
            service_vec[lane] = self.service_capacity

        # Queue dynamics:
        #   queue := max(0, queue + arrivals - service)
        self.queue = np.clip(self.queue + arrivals - service_vec, 0.0, None)

        # Reward: minimize total queue, with optional switch penalty.
        reward = -float(np.sum(self.queue))
        if self._prev_action is not None and lane != self._prev_action:
            reward -= self.switch_penalty
        self._prev_action = lane

        # Advance time.
        self.pos += 1
        terminated = self.pos >= len(self._dens) - 1
        obs = (
            self.queue.astype(np.float32)
            if not terminated
            else np.zeros(self.observation_space.shape, dtype=np.float32)
        )

        info = {
            "csv_path": self.current_file,
            "pos": self.pos,
            "action": lane,
            "queue": self.queue.copy().astype(np.float32),
            "recorded_density_now": dens_now.copy().astype(np.float32),
            "recorded_density_next": dens_next.copy().astype(np.float32),
        }

        return obs, reward, terminated, truncated, info

    def render(self, mode='human'):
        if self.queue is None:
            print(f"File: {self.current_file} | Pos: {self.pos}")
        else:
            q = np.round(self.queue, 2)
            print(f"File: {self.current_file} | Pos: {self.pos} | Queue: {q}")

    def close(self):
        pass

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.current_file = self._select_csv_path(options=options)
        self.df = pd.read_csv(self.current_file)

        # Extract arrays from CSV and initialize queue state from the replay snapshot.
        self._dens = extract_density_matrix(self.df, num_lanes=self.num_lanes)
        self.pos = 0
        self.queue = self._dens[self.pos].copy().astype(np.float32)
        self._prev_action = None

        obs = self.queue.copy()
        info = {"csv_path": self.current_file, "pos": self.pos}
        return obs, info
