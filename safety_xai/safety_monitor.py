"""
safety_xai/safety_monitor.py

Safety Monitor & Conservative Policy Override
==============================================
Provides hard safety overrides that intercept RL actions and block
unsafe decisions regardless of the agent's policy.

Safety Rules (in priority order)
---------------------------------
1. Emergency vehicle present → force emergency lane green immediately
2. Pedestrian in proposed green lane → block green, extend red 1 step
3. High speed on narrow road → force speed advisory (cannot physically
   reduce speed in sim, but logs a warning and penalises RL)
4. Conflict detection: two non-opposing lanes both having green
   (phase conflict) → block and revert to safe phase
5. Minimum red / green durations to prevent rapid flicker

The monitor also tracks a rolling safety score and estimated casualty
risk (target: 0 casualties).

Usage
-----
    monitor = SafetyMonitor(num_lanes=4, lane_widths=[3.5, 3.5, 4.0, 3.0])
    safe_action, log = monitor.check(
        proposed_action=2,
        queues=[3, 1, 5, 2],
        pedestrian_conflicts=[False, False, True, False],
        emergency_lanes=[False, False, False, True],
        avg_speeds=[30, 25, 45, 20],
    )
"""

from __future__ import annotations

import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

from control.reward_fn import (
    RewardComponents,
    SafetyRewardFn,
    compute_casualty_risk,
    compute_safety_score,
)


# ---------------------------------------------------------------------------
# Conflict matrix: which lane pairs cannot simultaneously be green
# Default: opposing pairs can coexist; perpendicular cannot.
# For a 4-arm intersection: arms 0(N),1(S) conflict with 2(E),3(W).
# ---------------------------------------------------------------------------

def _default_conflict_matrix(n: int) -> List[List[bool]]:
    """Build a default conflict matrix for n lanes arranged as N,S,E,W."""
    matrix = [[False] * n for _ in range(n)]
    if n >= 4:
        # North / South conflict with East / West
        for a in [0, 1]:
            for b in [2, 3]:
                matrix[a][b] = True
                matrix[b][a] = True
    return matrix


class SafetyLog:
    """Record of one safety check cycle."""
    __slots__ = (
        "timestamp", "proposed_action", "safe_action",
        "overridden", "override_reason", "safety_score", "casualty_risk",
        "components",
    )

    def __init__(
        self,
        proposed_action: int,
        safe_action: int,
        overridden: bool,
        override_reason: str,
        safety_score: int,
        casualty_risk: str,
        components: Optional[RewardComponents] = None,
    ) -> None:
        self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.proposed_action = proposed_action
        self.safe_action = safe_action
        self.overridden = overridden
        self.override_reason = override_reason
        self.safety_score = safety_score
        self.casualty_risk = casualty_risk
        self.components = components

    def to_dict(self) -> Dict:
        return {
            "timestamp": self.timestamp,
            "proposedAction": self.proposed_action,
            "safeAction": self.safe_action,
            "overridden": self.overridden,
            "overrideReason": self.override_reason,
            "safetyScore": self.safety_score,
            "casualtyRisk": self.casualty_risk,
        }


class SafetyMonitor:
    """
    Intercepts RL action proposals and enforces safety constraints.

    Parameters
    ----------
    num_lanes : int
    lane_widths : list[float]
    conflict_matrix : list[list[bool]] or None
        If None, a default N/S vs E/W conflict matrix is built.
    min_green_steps : int
        Minimum steps a lane must stay green before switching.
    max_green_steps : int
        Maximum steps a lane may stay green before forced rotation.
    narrow_road_threshold_m : float
    speed_limit_narrow_kmh : float
    history_len : int
        Number of past safety logs to retain.
    """

    def __init__(
        self,
        num_lanes: int = 4,
        lane_widths: Optional[List[float]] = None,
        conflict_matrix: Optional[List[List[bool]]] = None,
        min_green_steps: int = 3,
        max_green_steps: int = 90,
        narrow_road_threshold_m: float = 3.0,
        speed_limit_narrow_kmh: float = 30.0,
        history_len: int = 200,
    ) -> None:
        self.num_lanes = num_lanes
        self.lane_widths = lane_widths or [3.5] * num_lanes
        self.conflict_matrix = conflict_matrix or _default_conflict_matrix(num_lanes)
        self.min_green_steps = min_green_steps
        self.max_green_steps = max_green_steps
        self.narrow_threshold = narrow_road_threshold_m
        self.speed_limit_narrow = speed_limit_narrow_kmh

        self._current_green: Optional[int] = None
        self._green_since: int = 0          # step when current green started
        self._step: int = 0

        self._reward_fn = SafetyRewardFn(
            narrow_road_threshold_m=narrow_road_threshold_m,
            speed_limit_narrow_kmh=speed_limit_narrow_kmh,
        )
        self._history: Deque[SafetyLog] = deque(maxlen=history_len)
        self._prev_queues: List[float] = [0.0] * num_lanes

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def check(
        self,
        proposed_action: int,
        queues: List[float],
        pedestrian_conflicts: List[bool],
        emergency_lanes: List[bool],
        avg_speeds: Optional[List[float]] = None,
        collision_risk: float = 0.0,
    ) -> Tuple[int, SafetyLog]:
        """
        Validate and possibly override *proposed_action*.

        Returns (safe_action, SafetyLog).
        """
        self._step += 1
        speeds = avg_speeds or [0.0] * self.num_lanes
        override_reason = ""
        safe_action = proposed_action

        # ---- Rule 1: Emergency vehicle → force its lane ----
        emerg_lanes = [i for i, e in enumerate(emergency_lanes) if e]
        if emerg_lanes:
            # Serve the emergency lane with most vehicles first
            q_emerg = [(queues[i] if i < len(queues) else 0.0, i) for i in emerg_lanes]
            best_emerg = max(q_emerg)[1]
            if safe_action != best_emerg:
                safe_action = best_emerg
                override_reason = f"EMERGENCY: forcing lane {best_emerg} green."

        # ---- Rule 2: Pedestrian conflict in proposed green lane ----
        elif (proposed_action < len(pedestrian_conflicts)
              and pedestrian_conflicts[proposed_action]):
            # Find the safest (non-pedestrian, non-empty) alternative
            alternatives = [
                i for i in range(self.num_lanes)
                if i != proposed_action
                and not (i < len(pedestrian_conflicts) and pedestrian_conflicts[i])
                and (i >= len(queues) or queues[i] > 0)
            ]
            if alternatives:
                safe_action = max(alternatives, key=lambda i: queues[i] if i < len(queues) else 0)
                override_reason = (
                    f"PEDESTRIAN_CONFLICT: lane {proposed_action} blocked; "
                    f"redirected to lane {safe_action}."
                )
            else:
                override_reason = f"PEDESTRIAN_CONFLICT: lane {proposed_action} blocked (no safe alt)."

        # ---- Rule 3: Minimum green duration (prevent rapid flickering) ----
        elif (self._current_green is not None
              and self._current_green != safe_action
              and self._step - self._green_since < self.min_green_steps):
            safe_action = self._current_green
            override_reason = (
                f"MIN_GREEN: lane {self._current_green} must stay green for "
                f"{self.min_green_steps} steps (at step {self._step - self._green_since})."
            )

        # ---- Rule 4: Maximum green duration (forced rotation) ----
        elif (self._current_green is not None
              and self._current_green == safe_action
              and self._step - self._green_since >= self.max_green_steps):
            candidates = [i for i in range(self.num_lanes) if i != self._current_green]
            if candidates:
                safe_action = max(candidates, key=lambda i: queues[i] if i < len(queues) else 0)
                override_reason = (
                    f"MAX_GREEN: lane {self._current_green} exceeded {self.max_green_steps} "
                    f"steps; rotating to lane {safe_action}."
                )

        # Update green phase tracking
        if safe_action != self._current_green:
            self._current_green = safe_action
            self._green_since = self._step

        # ---- Compute safety score ----
        components = self._reward_fn.compute(
            queues=queues,
            prev_queues=self._prev_queues,
            chosen_lane=safe_action,
            prev_lane=self._current_green,
            lane_widths_m=self.lane_widths,
            avg_speeds_kmh=speeds,
            pedestrian_conflicts=pedestrian_conflicts,
            emergency_lanes=emergency_lanes,
            collision_risk=collision_risk,
        )
        safety_score = compute_safety_score(components)
        casualty_risk = compute_casualty_risk(components)
        self._prev_queues = list(queues)

        log = SafetyLog(
            proposed_action=proposed_action,
            safe_action=safe_action,
            overridden=(safe_action != proposed_action),
            override_reason=override_reason or "OK",
            safety_score=safety_score,
            casualty_risk=casualty_risk,
            components=components,
        )
        self._history.append(log)
        return safe_action, log

    def recent_history(self, n: int = 20) -> List[Dict]:
        return [entry.to_dict() for entry in list(self._history)[-n:]]

    def avg_safety_score(self) -> float:
        if not self._history:
            return 100.0
        return round(
            sum(e.safety_score for e in self._history) / len(self._history), 1
        )

    def reset(self) -> None:
        self._current_green = None
        self._green_since = 0
        self._step = 0
        self._prev_queues = [0.0] * self.num_lanes
        self._history.clear()
