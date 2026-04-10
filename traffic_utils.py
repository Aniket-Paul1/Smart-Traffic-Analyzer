import re
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


_DENSITY_LANE_RE = re.compile(r"^density_lane_(\d+)$")
_SPEED_LANE_RE = re.compile(r"^avg_speed_lane_(\d+)$")


def infer_num_lanes_from_df(df: pd.DataFrame) -> int:
    """
    Infers lane count from a dataframe.
    Supported schemas:
    - Canonical: density_lane_0..density_lane_{N-1} present.
    - Legacy (single lane): density + avg_speed_lane_0 present.
    """
    density_lane_ids = []
    for c in df.columns:
        m = _DENSITY_LANE_RE.match(str(c))
        if m:
            density_lane_ids.append(int(m.group(1)))

    if density_lane_ids:
        return max(density_lane_ids) + 1

    # Legacy single-lane fallback
    if "density" in df.columns:
        return 1

    raise ValueError(
        "Could not infer number of lanes. Expected density_lane_i columns or legacy 'density' column."
    )


def extract_density_matrix(df: pd.DataFrame, num_lanes: Optional[int] = None) -> np.ndarray:
    """
    Returns densities as float32 array shaped (T, num_lanes).
    Missing lane columns are padded with zeros.
    """
    if num_lanes is None:
        num_lanes = infer_num_lanes_from_df(df)

    out = np.zeros((len(df), num_lanes), dtype=np.float32)

    density_cols: Dict[int, str] = {}
    for c in df.columns:
        m = _DENSITY_LANE_RE.match(str(c))
        if m:
            density_cols[int(m.group(1))] = str(c)

    if density_cols:
        for lane_id, col in density_cols.items():
            if lane_id < num_lanes:
                out[:, lane_id] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).astype(np.float32).values
        return out

    # Legacy: density -> lane 0
    if "density" in df.columns and num_lanes >= 1:
        out[:, 0] = pd.to_numeric(df["density"], errors="coerce").fillna(0.0).astype(np.float32).values
        return out

    raise ValueError("No density columns found to extract.")


def extract_speed_matrix(df: pd.DataFrame, num_lanes: Optional[int] = None) -> np.ndarray:
    """
    Returns avg speeds as float32 array shaped (T, num_lanes).
    Missing lane columns are padded with zeros.
    """
    if num_lanes is None:
        num_lanes = infer_num_lanes_from_df(df)

    out = np.zeros((len(df), num_lanes), dtype=np.float32)

    speed_cols: Dict[int, str] = {}
    for c in df.columns:
        m = _SPEED_LANE_RE.match(str(c))
        if m:
            speed_cols[int(m.group(1))] = str(c)

    if speed_cols:
        for lane_id, col in speed_cols.items():
            if lane_id < num_lanes:
                out[:, lane_id] = pd.to_numeric(df[col], errors="coerce").fillna(0.0).astype(np.float32).values
        return out

    # Legacy: often only avg_speed_lane_0 exists
    if "avg_speed_lane_0" in df.columns and num_lanes >= 1:
        out[:, 0] = pd.to_numeric(df["avg_speed_lane_0"], errors="coerce").fillna(0.0).astype(np.float32).values
        return out

    return out


def extract_lane_columns_present(df: pd.DataFrame) -> Tuple[List[int], List[int]]:
    """Returns (density_lane_ids, speed_lane_ids) present in df."""
    density_lane_ids: List[int] = []
    speed_lane_ids: List[int] = []
    for c in df.columns:
        m = _DENSITY_LANE_RE.match(str(c))
        if m:
            density_lane_ids.append(int(m.group(1)))
        m = _SPEED_LANE_RE.match(str(c))
        if m:
            speed_lane_ids.append(int(m.group(1)))
    density_lane_ids.sort()
    speed_lane_ids.sort()
    return density_lane_ids, speed_lane_ids

