"""
utils/config_loader.py

Configuration loader for Smart Traffic Analyzer v2.
Reads config/config.yaml and merges environment-variable overrides.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import yaml
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False

_DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "config.yaml"


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """
    Load configuration from YAML file.

    Environment variable overrides follow the pattern:
      STA_<SECTION>_<KEY>=value  (case-insensitive)
    e.g. STA_LANES_NUM_LANES=6 overrides lanes.num_lanes

    Returns a nested dict matching the YAML structure.
    """
    cfg_path = Path(path) if path else _DEFAULT_CONFIG_PATH

    cfg: Dict[str, Any] = {}
    if _HAS_YAML and cfg_path.exists():
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    else:
        cfg = _default_config()

    # Apply env overrides
    for key, value in os.environ.items():
        if not key.upper().startswith("STA_"):
            continue
        parts = key.lower()[4:].split("_", 1)
        if len(parts) == 2:
            section, subkey = parts
            if section in cfg and isinstance(cfg[section], dict):
                # Coerce type to match existing value
                existing = cfg[section].get(subkey)
                cfg[section][subkey] = _coerce(value, existing)

    return cfg


def _coerce(value: str, reference: Any) -> Any:
    """Cast string env value to the same type as the existing config value."""
    if reference is None:
        return value
    if isinstance(reference, bool):
        return value.lower() not in ("0", "false", "no", "off")
    if isinstance(reference, int):
        try:
            return int(value)
        except ValueError:
            return reference
    if isinstance(reference, float):
        try:
            return float(value)
        except ValueError:
            return reference
    if isinstance(reference, list):
        return [v.strip() for v in value.split(",")]
    return value


def _default_config() -> Dict[str, Any]:
    """Minimal fallback config when YAML is unavailable."""
    return {
        "system": {"mode": "pseudo_live", "device": "cpu", "log_dir": "logs", "seed": 42},
        "lanes": {"num_lanes": 4, "widths_m": [3.5, 3.5, 4.0, 3.0], "vehicles_per_m_width": 2.5},
        "perception": {"model_weights": "yolov8n.pt", "skip_frames": 5, "smooth_window": 12},
        "prediction": {"gnn": {"enabled": True, "epochs": 50}, "transformer": {"enabled": True, "epochs": 50}},
        "control": {"dqn": {"total_timesteps": 200000}, "mappo": {"enabled": False}},
        "safety": {"min_green_steps": 3, "max_green_steps": 90},
        "simulation": {"enabled": False},
        "pseudo_live": {"state_file": "logs/pseudo_live_state.json"},
    }
