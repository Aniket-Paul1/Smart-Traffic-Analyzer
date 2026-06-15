"""
control/reward_fn.py

Safety-First Reward Function for Traffic Signal RL
===================================================
The reward is composed of multiple penalty and bonus terms:

  R = - w_queue    × total_queue_pressure
      - w_collision × predicted_collision_risk
      - w_ped       × pedestrian_conflict_penalty
      - w_speed     × narrow_road_speed_penalty
      - w_emergency × emergency_delay_penalty
      - w_switch    × switch_penalty
      + w_throughput × throughput_bonus

All weights are configurable.  The design goal is R = 0 at ideal state
(zero queue, zero conflict, zero delay) and negative for all deviations.
"""

from __future__ import annotations

import dataclasses
from typing import Dict, List, Optional


@dataclasses.dataclass
class RewardComponents:
    """Individual named components of one reward step (for logging / XAI)."""
    queue_penalty: float = 0.0
    collision_penalty: float = 0.0
    pedestrian_penalty: float = 0.0
    speed_penalty: float = 0.0
    emergency_penalty: float = 0.0
    switch_penalty: float = 0.0
    throughput_bonus: float = 0.0
    total: float = 0.0


class SafetyRewardFn:
    """
    Computes the composite reward given the current environment state.

    Parameters
    ----------
    w_queue : float         Weight on total queue length.
    w_collision : float     Weight on predicted near-miss / conflict risk.
    w_ped : float           Weight on pedestrian conflict (any pedestrian present
                            in the active lane during green = high penalty).
    w_speed : float         Weight on high speed in narrow lanes.
    w_emergency : float     Weight on delay when emergency vehicle is detected.
    w_switch : float        Penalty for switching the green lane (stability).
    w_throughput : float    Bonus for reducing queue on the chosen lane.
    narrow_road_threshold_m : float   Lanes narrower than this get speed penalty.
    speed_limit_narrow_kmh : float    Speed limit for narrow lanes.
    """

    def __init__(
        self,
        w_queue: float = 1.0,
        w_collision: float = 5.0,
        w_ped: float = 8.0,
        w_speed: float = 3.0,
        w_emergency: float = 10.0,
        w_switch: float = 0.5,
        w_throughput: float = 0.5,
        narrow_road_threshold_m: float = 3.0,
        speed_limit_narrow_kmh: float = 30.0,
    ) -> None:
        self.w_queue = w_queue
        self.w_collision = w_collision
        self.w_ped = w_ped
        self.w_speed = w_speed
        self.w_emergency = w_emergency
        self.w_switch = w_switch
        self.w_throughput = w_throughput
        self.narrow_threshold = narrow_road_threshold_m
        self.speed_limit_narrow = speed_limit_narrow_kmh

    def compute(
        self,
        queues: List[float],              # current queue per lane
        prev_queues: List[float],         # previous queue per lane (for throughput)
        chosen_lane: int,                 # index of the lane given green
        prev_lane: Optional[int],         # previously green lane (for switch penalty)
        lane_widths_m: List[float],       # physical lane width per lane
        avg_speeds_kmh: List[float],      # measured avg speed per lane
        pedestrian_conflicts: List[bool], # any pedestrian in lane area?
        emergency_lanes: List[bool],      # emergency vehicle in lane?
        collision_risk: float = 0.0,      # from safety monitor (0–1)
    ) -> RewardComponents:
        N = len(queues)

        # ---- Queue penalty ----
        total_queue = sum(queues)
        q_pen = -self.w_queue * total_queue

        # ---- Collision risk ----
        col_pen = -self.w_collision * collision_risk

        # ---- Pedestrian conflict on the ACTIVE (green) lane ----
        ped_in_green = pedestrian_conflicts[chosen_lane] if chosen_lane < len(pedestrian_conflicts) else False
        ped_pen = -self.w_ped if ped_in_green else 0.0

        # ---- Speed penalty on narrow lanes ----
        spd_pen = 0.0
        for i in range(N):
            if i < len(lane_widths_m) and lane_widths_m[i] < self.narrow_threshold:
                if i < len(avg_speeds_kmh) and avg_speeds_kmh[i] > self.speed_limit_narrow:
                    excess = avg_speeds_kmh[i] - self.speed_limit_narrow
                    spd_pen -= self.w_speed * (excess / self.speed_limit_narrow)

        # ---- Emergency delay penalty ----
        emerg_pen = 0.0
        for i, has_emerg in enumerate(emergency_lanes):
            if has_emerg and i != chosen_lane:
                # Emergency vehicle is NOT being served → big penalty
                emerg_pen -= self.w_emergency

        # ---- Switch penalty ----
        sw_pen = -self.w_switch if (prev_lane is not None and chosen_lane != prev_lane) else 0.0

        # ---- Throughput bonus: how much queue was cleared on chosen lane ----
        thr_bonus = 0.0
        if chosen_lane < N and chosen_lane < len(prev_queues):
            cleared = max(0.0, prev_queues[chosen_lane] - queues[chosen_lane])
            thr_bonus = self.w_throughput * cleared

        total = q_pen + col_pen + ped_pen + spd_pen + emerg_pen + sw_pen + thr_bonus

        return RewardComponents(
            queue_penalty=round(q_pen, 4),
            collision_penalty=round(col_pen, 4),
            pedestrian_penalty=round(ped_pen, 4),
            speed_penalty=round(spd_pen, 4),
            emergency_penalty=round(emerg_pen, 4),
            switch_penalty=round(sw_pen, 4),
            throughput_bonus=round(thr_bonus, 4),
            total=round(total, 4),
        )


# ---------------------------------------------------------------------------
# Convenience: safety score for UI display (0 = perfect, 100 = very unsafe)
# ---------------------------------------------------------------------------

def compute_safety_score(components: RewardComponents) -> int:
    """
    Maps reward components to an intuitive 0–100 safety score.
    100 = fully safe, 0 = most dangerous observed state.
    """
    raw_risk = (
        abs(components.collision_penalty) * 2.0
        + abs(components.pedestrian_penalty) * 1.5
        + abs(components.speed_penalty)
        + abs(components.emergency_penalty) * 0.5
    )
    # Clamp to [0, 100] and invert (lower risk → higher score)
    score = max(0, 100 - int(raw_risk * 5))
    return min(100, score)


def compute_casualty_risk(components: RewardComponents) -> str:
    """Returns a human-readable estimated casualty risk label."""
    score = compute_safety_score(components)
    if score >= 90:
        return "Minimal"
    if score >= 70:
        return "Low"
    if score >= 50:
        return "Moderate"
    if score >= 30:
        return "High"
    return "Critical"
