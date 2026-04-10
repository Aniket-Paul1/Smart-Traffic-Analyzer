from typing import Optional

import gymnasium as gym
from gymnasium import spaces
import numpy as np


class GreenDurationEnv(gym.Env):
    """
    Environment to learn mapping from lane density -> green duration.

    Observation:
      - Single scalar: normalized density in [0, 1]

    Action:
      - Discrete index into duration bucket list
        (e.g. [40, 50, 60, 70, 80, 90] seconds).

    Reward (one-step episode):
      - Encourage:
          * low density -> short duration
          * high density -> long duration
        via a continuous target function and a negative distance penalty.
    """

    metadata = {"render.modes": ["human"]}

    def __init__(
        self,
        min_sec: float = 40.0,
        max_sec: float = 90.0,
        num_buckets: int = 6,
        density_noise: float = 0.05,
    ):
        super().__init__()
        self.min_sec = float(min_sec)
        self.max_sec = float(max_sec)
        self.num_buckets = int(num_buckets)
        self.density_noise = float(density_noise)

        # Observation: normalized density in [0, 1]
        self.observation_space = spaces.Box(
            low=np.array([0.0], dtype=np.float32),
            high=np.array([1.0], dtype=np.float32),
            dtype=np.float32,
        )

        # Action: duration bucket index
        self.action_space = spaces.Discrete(self.num_buckets)

        # Precompute bucket centers and durations.
        # Uniform buckets between min_sec and max_sec.
        self.durations = np.linspace(self.min_sec, self.max_sec, self.num_buckets, dtype=np.float32)

        self._density: Optional[float] = None

    def _sample_density(self) -> float:
        """
        Sample a "true" density value in [0, 1].
        Here we use a simple mixture: more often low or high to force learning extremes.
        """
        u = np.random.rand()
        if u < 0.33:
            # Mostly low
            d = np.random.beta(2.0, 6.0)
        elif u < 0.66:
            # Mostly medium
            d = np.random.beta(3.0, 3.0)
        else:
            # Mostly high
            d = np.random.beta(6.0, 2.0)
        return float(np.clip(d, 0.0, 1.0))

    def _target_duration_for_density(self, dens: float) -> float:
        """
        Ideal duration given true density:
          - dens ≈ 0 -> min_sec
          - dens ≈ 1 -> max_sec
          - smooth interpolation in between.
        """
        dens = float(np.clip(dens, 0.0, 1.0))
        return self.min_sec + (self.max_sec - self.min_sec) * dens

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)

        # Sample a density scenario for this single-step episode.
        base_dens = self._sample_density()
        noisy_dens = base_dens + np.random.randn() * self.density_noise
        noisy_dens = float(np.clip(noisy_dens, 0.0, 1.0))

        self._density = base_dens
        obs = np.array([noisy_dens], dtype=np.float32)
        info = {
            "base_density": float(base_dens),
            "noisy_density": float(noisy_dens),
        }
        return obs, info

    def step(self, action):
        assert self._density is not None, "reset() must be called before step()."

        a = int(action)
        a = max(0, min(self.num_buckets - 1, a))
        chosen_dur = float(self.durations[a])
        target_dur = float(self._target_duration_for_density(self._density))

        # Reward: negative absolute error scaled.
        err = abs(chosen_dur - target_dur)
        # Normalize error by half-range so max error ~ -1
        half_range = 0.5 * (self.max_sec - self.min_sec)
        if half_range <= 0:
            half_range = 1.0
        reward = -float(err / half_range)

        terminated = True  # single-step episode
        truncated = False

        obs = np.array([0.0], dtype=np.float32)  # dummy; episode ends
        info = {
            "density": float(self._density),
            "chosen_duration": chosen_dur,
            "target_duration": target_dur,
            "error": float(err),
        }
        return obs, reward, terminated, truncated, info

    def render(self, mode="human"):
        print(f"density={self._density}")

    def close(self):
        pass

