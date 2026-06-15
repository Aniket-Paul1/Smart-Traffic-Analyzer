"""
safety_xai/explainer.py

Explainable AI Module
=====================
Provides human-readable explanations for AI decisions using:
1. SHAP-style feature importance (model-agnostic, permutation-based)
2. Attention weight visualization for Transformer predictions
3. Interpretable natural-language decision summaries

Does NOT require the full SHAP library — uses a fast permutation-based
approximation so it works in any environment.

Usage
-----
    explainer = TrafficExplainer(feature_names=[...])

    # For RL decisions:
    importance = explainer.permutation_importance(model_fn, obs, n_repeats=10)
    summary = explainer.summarise_decision(obs, action, lane_widths, congestion)

    # For transformer attention:
    viz = explainer.attention_heatmap(attn_weights)   # returns SVG string
"""

from __future__ import annotations

import html
import json
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# Feature names (must match observation vector order)
# ---------------------------------------------------------------------------

def default_feature_names(num_lanes: int) -> List[str]:
    names = []
    for i in range(num_lanes):
        names += [
            f"L{i+1}_count",
            f"L{i+1}_speed",
            f"L{i+1}_queue",
            f"L{i+1}_cong",
            f"L{i+1}_width",
        ]
    return names


# ---------------------------------------------------------------------------
# Permutation-based feature importance
# ---------------------------------------------------------------------------

class PermutationImportance:
    """
    Model-agnostic feature importance via random permutation.
    Estimates how much each feature contributes to the model output
    by measuring the change in output when that feature is shuffled.

    Parameters
    ----------
    model_fn : callable  obs (np.ndarray) → scalar or action_index
    n_repeats : int      Number of permutations per feature.
    """

    def __init__(self, model_fn: Callable, n_repeats: int = 10) -> None:
        self.model_fn = model_fn
        self.n_repeats = n_repeats

    def compute(
        self,
        obs: np.ndarray,
        baseline_output: Optional[float] = None,
    ) -> np.ndarray:
        """
        Returns importance array of shape (len(obs),).
        Positive value = feature pushes toward current action.
        """
        if baseline_output is None:
            baseline_output = float(self.model_fn(obs))

        importance = np.zeros(len(obs), dtype=np.float32)
        for feat_idx in range(len(obs)):
            diffs = []
            for _ in range(self.n_repeats):
                perturbed = obs.copy()
                perturbed[feat_idx] = np.random.uniform(0.0, 1.0)
                out = float(self.model_fn(perturbed))
                diffs.append(abs(baseline_output - out))
            importance[feat_idx] = float(np.mean(diffs))

        # Normalise to [0, 1]
        max_imp = importance.max()
        if max_imp > 0:
            importance /= max_imp
        return importance


# ---------------------------------------------------------------------------
# Attention heatmap renderer (SVG)
# ---------------------------------------------------------------------------

def render_attention_heatmap(
    attn_weights: np.ndarray,
    x_labels: Optional[List[str]] = None,
    y_labels: Optional[List[str]] = None,
    title: str = "Attention Weights",
    cell_size: int = 36,
) -> str:
    """
    Render a 2-D attention weight matrix as an SVG string.

    Parameters
    ----------
    attn_weights : (rows, cols) float array, values in [0,1]
    x_labels : column labels
    y_labels : row labels

    Returns SVG string suitable for embedding in HTML.
    """
    rows, cols = attn_weights.shape
    xl = x_labels or [str(i) for i in range(cols)]
    yl = y_labels or [str(i) for i in range(rows)]

    label_w = 60
    label_h = 40
    w = label_w + cols * cell_size + 10
    h = label_h + rows * cell_size + 10

    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
             f'style="font-family:monospace;font-size:10px;background:#0f172a">']

    # Title
    lines.append(f'<text x="{w//2}" y="14" text-anchor="middle" fill="#94a3b8">'
                 f'{html.escape(title)}</text>')

    # Column labels
    for j, label in enumerate(xl):
        x = label_w + j * cell_size + cell_size // 2
        lines.append(f'<text x="{x}" y="30" text-anchor="middle" fill="#64748b">'
                     f'{html.escape(str(label)[:6])}</text>')

    # Cells + row labels
    for i in range(rows):
        y_top = label_h + i * cell_size
        # Row label
        lines.append(f'<text x="{label_w - 4}" y="{y_top + cell_size//2 + 4}" '
                     f'text-anchor="end" fill="#64748b">{html.escape(str(yl[i])[:8])}</text>')
        for j in range(cols):
            val = float(attn_weights[i, j])
            val = max(0.0, min(1.0, val))
            # Interpolate colour: dark-blue (0) → cyan (1)
            r = int(0 + val * 34)
            g = int(30 + val * (211 - 30))
            b = int(60 + val * (238 - 60))
            fill = f"rgb({r},{g},{b})"
            x_left = label_w + j * cell_size
            lines.append(
                f'<rect x="{x_left}" y="{y_top}" width="{cell_size}" height="{cell_size}" '
                f'fill="{fill}" stroke="#1e293b" stroke-width="1"/>'
            )
            txt_color = "#000" if val > 0.6 else "#94a3b8"
            lines.append(
                f'<text x="{x_left + cell_size//2}" y="{y_top + cell_size//2 + 4}" '
                f'text-anchor="middle" fill="{txt_color}">{val:.2f}</text>'
            )

    lines.append("</svg>")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Natural-language decision summary
# ---------------------------------------------------------------------------

class TrafficExplainer:
    """
    Produces human-readable explanations for AI decisions.

    Parameters
    ----------
    num_lanes : int
    lane_widths : list[float]
    feature_names : list[str] or None
    vehicles_per_m_width : float
    """

    def __init__(
        self,
        num_lanes: int = 4,
        lane_widths: Optional[List[float]] = None,
        feature_names: Optional[List[str]] = None,
        vehicles_per_m_width: float = 2.5,
    ) -> None:
        self.num_lanes = num_lanes
        self.lane_widths = lane_widths or [3.5] * num_lanes
        self.capacities = [max(1.0, w * vehicles_per_m_width) for w in self.lane_widths]
        self.feature_names = feature_names or default_feature_names(num_lanes)

    def summarise_decision(
        self,
        chosen_lane: int,
        obs: np.ndarray,
        importance: Optional[np.ndarray] = None,
        safety_score: int = 100,
        casualty_risk: str = "Minimal",
        override_reason: str = "OK",
    ) -> Dict:
        """
        Build a structured explanation dict for the UI.

        Returns
        -------
        {
          "summary": str,
          "topFeatures": [{"name": str, "importance": float}, ...],
          "safetyScore": int,
          "casualtyRisk": str,
          "overrideActive": bool,
          "overrideReason": str,
          "laneDetails": [{...}, ...],
        }
        """
        # Per-lane obs slices (OBS_PER_LANE = 5)
        OPL = 5
        lane_details = []
        for i in range(self.num_lanes):
            base = i * OPL
            if base + OPL <= len(obs):
                count_n, speed_n, queue_n, cong, width_n = obs[base: base + OPL]
                count = round(count_n * 20)
                speed = round(speed_n * 100, 1)
                queue = round(queue_n * 20)
                cap = self.capacities[i]
                lane_details.append({
                    "lane": i + 1,
                    "vehicleCount": count,
                    "avgSpeedKmh": speed,
                    "queue": queue,
                    "congestionNorm": round(float(cong), 3),
                    "laneWidthM": self.lane_widths[i],
                    "capacity": round(cap, 1),
                    "formula": f"{count} ÷ {cap:.1f} = {count/cap:.2f}",
                })

        # Build natural-language summary
        chosen_detail = next((d for d in lane_details if d["lane"] == chosen_lane + 1), None)
        if chosen_detail:
            cong_pct = int(chosen_detail["congestionNorm"] * 100)
            cong_label = "very high" if cong_pct >= 75 else "moderate" if cong_pct >= 35 else "low"
            summary = (
                f"Lane {chosen_lane + 1} selected for green. "
                f"Width: {chosen_detail['laneWidthM']:.1f} m, "
                f"capacity ≈ {chosen_detail['capacity']} vehicles, "
                f"congestion score: {chosen_detail['congestionNorm']:.2f} ({cong_label}). "
                f"Safety score: {safety_score}/100. Estimated casualty risk: {casualty_risk}."
            )
        else:
            summary = f"Lane {chosen_lane + 1} selected. Safety score: {safety_score}/100."

        if override_reason != "OK":
            summary = f"[SAFETY OVERRIDE] {override_reason} " + summary

        # Top features by importance
        top_features = []
        if importance is not None and len(importance) == len(self.feature_names):
            idx_sorted = np.argsort(importance)[::-1][:6]
            top_features = [
                {"name": self.feature_names[idx], "importance": round(float(importance[idx]), 3)}
                for idx in idx_sorted
            ]

        return {
            "summary": summary,
            "topFeatures": top_features,
            "safetyScore": safety_score,
            "casualtyRisk": casualty_risk,
            "overrideActive": override_reason != "OK",
            "overrideReason": override_reason,
            "laneDetails": lane_details,
        }

    def attention_heatmap_svg(
        self,
        attn_weights: np.ndarray,
        time_labels: Optional[List[str]] = None,
        lane_labels: Optional[List[str]] = None,
    ) -> str:
        """
        Generate SVG attention heatmap for transformer prediction.
        attn_weights: (T_in, N) — attention from each timestep to each lane.
        """
        t_labels = time_labels or [f"t-{i}" for i in range(attn_weights.shape[0] - 1, -1, -1)]
        n_labels = lane_labels or [f"Lane {i + 1}" for i in range(attn_weights.shape[1])]
        return render_attention_heatmap(
            attn_weights,
            x_labels=n_labels,
            y_labels=t_labels,
            title="Transformer Attention",
        )

    def importance_json(self, importance: np.ndarray) -> str:
        data = [
            {"feature": self.feature_names[i], "importance": round(float(v), 4)}
            for i, v in enumerate(importance)
        ]
        return json.dumps(data)
