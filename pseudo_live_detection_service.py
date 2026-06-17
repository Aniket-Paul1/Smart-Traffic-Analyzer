"""
pseudo_live_detection_service.py  (v2 — Smart Traffic Analyzer)

Pseudo-Live Multi-Lane Detection Service
=========================================
Reads per-lane video sources (real files played on loop, or RTSP streams),
runs YOLOv8 + DeepSort detection and tracking on every lane in parallel
threads, and writes a live JSON state file every ~0.5 s for the dashboard.

New in v2
---------
- Width-aware congestion:  score = smoothedCount / (laneWidthM × 2.5)
- Pedestrian & emergency vehicle detection (COCO classes 0, 1, 5, 7)
- Road-width estimation via IPM (perception/road_width_estimator.py)
- Safety monitor integration (safety_xai/safety_monitor.py)
- congestionModel metadata written to state JSON

Lane widths are read from VITE_LANE_WIDTHS env variable (metres, CSV):
    VITE_LANE_WIDTHS=3.5,3.5,4.0,3.0,4.0,3.5,3.0,4.0,3.5
"""

import json
import math
import os
import signal
import sys
import tempfile
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional


ROOT_DIR = Path(__file__).resolve().parent
TRAFFIC_WEB_DIR = ROOT_DIR / 'traffic-web'
PUBLIC_DIR = TRAFFIC_WEB_DIR / 'public'
DEFAULT_ENV_FILES = [TRAFFIC_WEB_DIR / '.env', ROOT_DIR / '.env']
DEFAULT_STATE_FILE = ROOT_DIR / 'logs' / 'pseudo_live_state.json'

VEHICLE_CLASSES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}
PEDESTRIAN_CLASS = 0
CYCLIST_CLASS = 1
ALL_DETECT_CLASSES = set(VEHICLE_CLASSES.keys()) | {PEDESTRIAN_CLASS, CYCLIST_CLASS}

RUNNING = True

# ---------------------------------------------------------------------------
# Width-aware congestion model
# ---------------------------------------------------------------------------
# congestionScore = smoothedVehicleCount / laneCapacity
# laneCapacity    = laneWidthMeters × VEHICLES_PER_METER_WIDTH
#
# Example (mentor's scenario):
#   Lane A: 4 m wide, 8 vehicles → 8 / (4 × 2.5) = 0.80  HIGH
#   Lane B: 2 m wide, 5 vehicles → 5 / (2 × 2.5) = 1.00  MAX  ← more congested despite fewer cars
#
# Configure in .env:  VITE_LANE_WIDTHS=3.5,3.5,4.0,3.0,4.0,3.5,3.0,4.0,3.5
# ---------------------------------------------------------------------------
VEHICLES_PER_METER_WIDTH: float = 2.5
DEFAULT_LANE_WIDTH_M: float = 3.5


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_env_files(paths: List[Path]) -> None:
    for env_path in paths:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding='utf-8').splitlines():
            line = raw_line.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('export '):
                line = line[7:].strip()
            if '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip()
            if key in os.environ and os.environ[key] != '':
                continue
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except Exception:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except Exception:
        return default


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {'0', 'false', 'no', 'off'}


def write_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as tmp:
        json.dump(payload, tmp, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = tmp.name

    # On Windows the target file may be briefly locked by Node.js reading it.
    # Retry os.replace() up to 5 times before falling back to a direct write.
    for attempt in range(5):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == 4:
                try:
                    with open(path, 'w', encoding='utf-8') as f:
                        json.dump(payload, f, indent=2)
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                except Exception:
                    pass
                return
            time.sleep(0.05)


def camera_urls_from_env(max_lanes: int = 9) -> List[str]:
    raw = str(os.getenv('VITE_CAMERA_URLS', '')).strip()
    if not raw:
        return [''] * max_lanes
    parts = [part.strip() for part in raw.split(',')]
    while len(parts) < max_lanes:
        parts.append('')
    return parts[:max_lanes]


def lane_widths_from_env(max_lanes: int = 9) -> List[float]:
    """Parse VITE_LANE_WIDTHS into a list of per-lane widths (metres)."""
    raw = str(os.getenv('VITE_LANE_WIDTHS', '')).strip()
    widths: List[float] = []
    if raw:
        for part in raw.split(','):
            try:
                w = float(part.strip())
                widths.append(max(0.5, w))
            except ValueError:
                widths.append(DEFAULT_LANE_WIDTH_M)
    while len(widths) < max_lanes:
        widths.append(DEFAULT_LANE_WIDTH_M)
    return widths[:max_lanes]


def resolve_source(raw: str) -> Optional[str]:
    if not raw:
        return None
    lower = raw.lower()
    if lower.startswith(('rtsp://', 'http://', 'https://')):
        return raw
    candidate = Path(raw)
    if candidate.is_absolute():
        return str(candidate)
    for base in (PUBLIC_DIR, TRAFFIC_WEB_DIR, ROOT_DIR):
        full = (base / raw).resolve()
        if full.exists():
            return str(full)
    return str((PUBLIC_DIR / raw).resolve())


def is_remote_source(source: str) -> bool:
    return source.lower().startswith(('rtsp://', 'http://', 'https://'))


class LaneWorker:
    def __init__(self, lane_id: int, raw_source: str, config: dict, modules: dict):
        self.id = lane_id
        self.name = f'Lane {lane_id}'
        self.raw_source = raw_source
        self.resolved_source = resolve_source(raw_source) if raw_source else None
        self.configured = bool(self.resolved_source)
        self.cv2 = modules['cv2']
        self.np = modules['np']
        self.model = modules['model']
        self.tracker_cls = modules['tracker_cls']
        self.tracking_enabled = modules['tracking_enabled']
        self.config = config

        # Width-aware congestion
        widths = config.get('lane_widths', [])
        # config_width is the fallback from .env — used only when AI estimation fails
        self.config_width_m: float = float(
            widths[lane_id - 1] if widths and lane_id - 1 < len(widths) else DEFAULT_LANE_WIDTH_M
        )
        # lane_width_m starts as config value but gets REPLACED by AI estimate once confident
        self.lane_width_m: float = self.config_width_m
        self.lane_capacity: float = max(1.0, self.lane_width_m * VEHICLES_PER_METER_WIDTH)
        self.width_source: str = 'config'   # tracks which source is active: 'config' or 'ai_ipm'

        self.cap = None
        self.fps = 20.0
        self.next_frame_at = 0.0
        self.next_retry_at = 0.0
        self.frame_idx = 0
        self.prev_dets = []
        self.density_hist: deque = deque(maxlen=config['smooth_window'])
        self.prev_centroid: dict = {}
        self.track_speeds: dict = defaultdict(list)
        self.error: Optional[str] = None
        self.available = False
        self.vehicle_count = 0
        self.pedestrian_count = 0
        self.emergency_detected = False
        self.smoothed_vehicle_count = 0.0
        self.avg_speed_kmh = 0.0
        self.observed_peak = float(config['density_reference'])
        self.updated_at = None
        self.tracker = (
            self.tracker_cls(max_age=config['tracker_max_age'])
            if self.tracking_enabled and self.tracker_cls
            else None
        )
        # Road-width estimator (optional, imported at runtime)
        self._width_estimator = modules.get('width_estimator')
        self.estimated_width_m: Optional[float] = None
        self.width_confidence: float = 0.0

    def open_capture(self) -> bool:
        if not self.configured:
            self.available = False
            self.error = 'Lane source is not configured.'
            return False
        if not is_remote_source(self.resolved_source) and not Path(self.resolved_source).exists():
            self.available = False
            self.error = f'Source not found: {self.resolved_source}'
            return False
        self.cap = self.cv2.VideoCapture(self.resolved_source)
        if not self.cap or not self.cap.isOpened():
            self.available = False
            self.error = f'Unable to open source: {self.resolved_source}'
            return False
        detected_fps = float(self.cap.get(self.cv2.CAP_PROP_FPS) or 0.0)
        if detected_fps > 0:
            self.fps = detected_fps
        self.available = True
        self.error = None
        self.next_frame_at = time.time()
        return True

    def _handle_end_of_stream(self) -> bool:
        if not self.cap:
            return False
        if is_remote_source(self.resolved_source):
            self.cap.release()
            self.cap = None
            return False
        self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, 0)
        return True

    def _read_frame(self):
        if not self.cap and not self.open_capture():
            self.next_retry_at = time.time() + self.config['retry_sec']
            return None
        if not self.cap:
            return None
        ret, frame = self.cap.read()
        if ret and frame is not None:
            return frame
        if self._handle_end_of_stream():
            ret, frame = self.cap.read()
            if ret and frame is not None:
                return frame
        self.available = False
        self.error = f'Frame read failed for {self.resolved_source}'
        try:
            self.cap.release()
        except Exception:
            pass
        self.cap = None
        self.next_retry_at = time.time() + self.config['retry_sec']
        return None

    def maybe_process(self, now: float) -> bool:
        if not self.configured:
            return False
        if now < self.next_frame_at:
            return False
        if self.cap is None and now < self.next_retry_at:
            return False

        frame = self._read_frame()
        self.next_frame_at = now + max(0.02, (1.0 / max(self.fps, 1.0)) / self.config['speed_multiplier'])
        if frame is None:
            return False

        self.frame_idx += 1
        frame_h, frame_w = frame.shape[:2]
        resized = self.cv2.resize(frame, (self.config['inference_width'], self.config['inference_height']))

        # --- Road width estimation (every 30 frames to save compute) ---
        # When the AI estimator returns a confident result it becomes the PRIMARY
        # source for lane_width_m and lane_capacity — directly affecting the
        # congestion score.  The .env config width is only a fallback for when
        # the camera feed is unavailable or estimation confidence is too low.
        if self._width_estimator and self.frame_idx % 30 == 0:
            try:
                result = self._width_estimator.estimate(resized)
                # Confidence threshold 0.4 — only trust the AI estimate when the
                # road mask covers a meaningful portion of the BEV image.
                # Width sanity check: must be between 1 m and 12 m (real road range).
                if result.confidence >= 0.4 and 1.0 <= result.lane_width_m <= 12.0:
                    self.estimated_width_m = result.lane_width_m
                    self.width_confidence = result.confidence
                    # ── AI estimate replaces config value as active width ──────
                    # Use an exponential moving average so the width updates
                    # smoothly rather than jumping frame-to-frame:
                    #   new_width = 0.8 × old_width + 0.2 × ai_estimate
                    alpha = 0.2
                    self.lane_width_m = (
                        (1 - alpha) * self.lane_width_m + alpha * result.lane_width_m
                    )
                    self.lane_capacity = max(1.0, self.lane_width_m * VEHICLES_PER_METER_WIDTH)
                    self.width_source = 'ai_ipm'
                else:
                    # Low confidence — fall back to config width
                    if self.width_source == 'config':
                        self.lane_width_m = self.config_width_m
                        self.lane_capacity = max(1.0, self.lane_width_m * VEHICLES_PER_METER_WIDTH)
            except Exception:
                pass

        # --- YOLO inference ---
        dets = self.prev_dets
        if self.frame_idx % self.config['skip_frames'] == 0:
            dets = []
            try:
                results = self.model(resized, verbose=False)[0]
                scale_x = frame_w / self.config['inference_width']
                scale_y = frame_h / self.config['inference_height']
                for box in results.boxes.data.tolist():
                    x1, y1, x2, y2, conf, cls = box
                    cls = int(cls)
                    if cls not in ALL_DETECT_CLASSES:
                        continue
                    dets.append((
                        [int(x1 * scale_x), int(y1 * scale_y), int(x2 * scale_x), int(y2 * scale_y)],
                        float(conf),
                        cls,
                    ))
                self.prev_dets = dets
                self.error = None
            except Exception as exc:
                self.error = f'Inference failed: {exc}'

        # --- Tracking & per-class counting ---
        vehicle_count = 0
        pedestrian_count = 0
        emergency_detected = False
        avg_speed_kmh = 0.0

        if self.tracker is not None:
            try:
                outputs = self.tracker.update_tracks(dets, frame=frame)
            except Exception as exc:
                outputs = []
                self.error = f'Tracker failed: {exc}'
            lane_speeds = []
            active_ids = set()
            for track in outputs:
                if not track.is_confirmed():
                    continue
                cls_id = int(track.det_class) if track.det_class is not None else 2
                active_ids.add(track.track_id)

                if cls_id == PEDESTRIAN_CLASS or cls_id == CYCLIST_CLASS:
                    pedestrian_count += 1
                    continue
                if cls_id in VEHICLE_CLASSES:
                    vehicle_count += 1
                    # Emergency heuristic: bus/truck with high confidence
                    if cls_id in (5, 7) and (track.det_conf or 0) >= 0.82:
                        emergency_detected = True

                lx, ly, w, h = track.to_ltwh()
                cx, cy = int(lx + w / 2), int(ly + h / 2)
                if track.track_id in self.prev_centroid:
                    px, py = self.prev_centroid[track.track_id]
                    dist_pix = math.hypot(cx - px, cy - py)
                    speed_mps = dist_pix * self.config['scale_factor'] * self.fps / max(1, self.config['skip_frames'])
                    lane_speeds.append(speed_mps * 3.6)
                self.prev_centroid[track.track_id] = (cx, cy)
            avg_speed_kmh = float(sum(lane_speeds) / len(lane_speeds)) if lane_speeds else 0.0
            self.prev_centroid = {tid: self.prev_centroid[tid] for tid in active_ids if tid in self.prev_centroid}
        else:
            for _, conf, cls_id in dets:
                if cls_id in (PEDESTRIAN_CLASS, CYCLIST_CLASS):
                    pedestrian_count += 1
                elif cls_id in VEHICLE_CLASSES:
                    vehicle_count += 1

        self.vehicle_count = int(vehicle_count)
        self.pedestrian_count = int(pedestrian_count)
        self.emergency_detected = emergency_detected
        self.density_hist.append(float(vehicle_count))
        self.smoothed_vehicle_count = float(sum(self.density_hist) / len(self.density_hist)) if self.density_hist else 0.0
        self.avg_speed_kmh = avg_speed_kmh
        self.observed_peak = max(self.observed_peak, self.smoothed_vehicle_count)
        self.updated_at = utc_now_iso()
        self.available = True
        return True

    def to_state(self) -> dict:
        # Width-aware congestion score — uses AI-estimated width when available,
        # falls back to config width.  self.lane_width_m is always the ACTIVE value.
        congestion_norm = None
        if self.configured:
            raw_score = self.smoothed_vehicle_count / self.lane_capacity
            congestion_norm = max(0.0, min(1.0, raw_score))

        return {
            'id': self.id,
            'name': self.name,
            'source': self.raw_source or None,
            'resolvedSource': self.resolved_source,
            'configured': self.configured,
            'available': self.available,
            'vehicleCount': self.vehicle_count,
            'pedestrianCount': self.pedestrian_count,
            'emergencyDetected': self.emergency_detected,
            'smoothedVehicleCount': round(self.smoothed_vehicle_count, 3),
            'avgSpeedKmh': round(self.avg_speed_kmh, 3),
            'observedPeak': round(self.observed_peak, 3),
            # Active (effective) width — AI-estimated when confident, else config
            'laneWidthM': round(self.lane_width_m, 3),
            'laneCapacity': round(self.lane_capacity, 3),
            # AI IPM estimate details
            'estimatedWidthM': round(self.estimated_width_m, 3) if self.estimated_width_m else None,
            'widthConfidence': round(self.width_confidence, 3),
            # Config fallback value — always available for comparison
            'configWidthM': round(self.config_width_m, 2),
            # Which source is currently driving the congestion formula
            'widthSource': self.width_source,   # 'ai_ipm' or 'config'
            'congestionNorm': round(congestion_norm, 4) if congestion_norm is not None else None,
            'updatedAt': self.updated_at,
            'frameIndex': self.frame_idx,
            'error': self.error,
        }


def build_idle_state(camera_urls: List[str], state_file: Path, error: Optional[str] = None) -> dict:
    lane_widths = lane_widths_from_env()
    lanes = []
    for idx, raw_source in enumerate(camera_urls, start=1):
        resolved = resolve_source(raw_source) if raw_source else None
        width_m = lane_widths[idx - 1] if idx - 1 < len(lane_widths) else DEFAULT_LANE_WIDTH_M
        capacity = max(1.0, width_m * VEHICLES_PER_METER_WIDTH)
        lanes.append({
            'id': idx,
            'name': f'Lane {idx}',
            'source': raw_source or None,
            'resolvedSource': resolved,
            'configured': bool(raw_source),
            'available': False,
            'vehicleCount': 0,
            'pedestrianCount': 0,
            'emergencyDetected': False,
            'smoothedVehicleCount': 0,
            'avgSpeedKmh': 0,
            'observedPeak': 0,
            'laneWidthM': round(width_m, 2),
            'laneCapacity': round(capacity, 2),
            'estimatedWidthM': None,
            'widthConfidence': 0,
            'congestionNorm': 0 if raw_source else None,
            'updatedAt': None,
            'frameIndex': 0,
            'error': error if raw_source else None,
        })
    return {
        'mode': 'pseudo-live',
        'running': True,
        'updatedAt': utc_now_iso(),
        'stateFile': str(state_file),
        'lanes': lanes,
        'error': error,
        'congestionModel': {
            'formula': 'smoothedVehicleCount / (laneWidthM × VEHICLES_PER_METER_WIDTH)',
            'vehiclesPerMeterWidth': VEHICLES_PER_METER_WIDTH,
            'defaultLaneWidthM': DEFAULT_LANE_WIDTH_M,
        },
    }


def install_signal_handlers():
    def _handle(_signum, _frame):
        global RUNNING
        RUNNING = False
    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)


def load_modules(enable_tracking: bool):
    try:
        import cv2
        import numpy as np
        from ultralytics import YOLO
    except Exception as exc:
        raise RuntimeError(f'Missing runtime dependency: {exc}') from exc

    tracker_cls = None
    tracking_enabled = False
    if enable_tracking:
        try:
            from deep_sort_realtime.deepsort_tracker import DeepSort
            tracker_cls = DeepSort
            tracking_enabled = True
        except Exception as exc:
            print(f'DeepSort unavailable: {exc}', file=sys.stderr)

    # Attempt to load road-width estimator
    width_estimator = None
    try:
        sys.path.insert(0, str(ROOT_DIR))
        from perception.road_width_estimator import RoadWidthEstimator
        width_estimator = RoadWidthEstimator(calibration_m_per_px=0.025)
    except Exception as exc:
        print(f'RoadWidthEstimator unavailable (non-fatal): {exc}', file=sys.stderr)

    weights_path = os.getenv('PSEUDO_LIVE_MODEL_WEIGHTS', 'yolo11n.pt')
    resolved_weights = str((ROOT_DIR / weights_path).resolve()) if not Path(weights_path).is_absolute() else weights_path
    model = YOLO(resolved_weights)

    return {
        'cv2': cv2,
        'np': np,
        'model': model,
        'tracker_cls': tracker_cls,
        'tracking_enabled': tracking_enabled,
        'width_estimator': width_estimator,
    }


def main() -> int:
    load_env_files(DEFAULT_ENV_FILES)
    install_signal_handlers()

    state_file = Path(os.getenv('PSEUDO_LIVE_STATE_FILE', str(DEFAULT_STATE_FILE))).resolve()
    camera_urls = camera_urls_from_env()
    lane_widths = lane_widths_from_env()

    config = {
        'skip_frames': max(1, env_int('PSEUDO_LIVE_DETECTION_SKIP_FRAMES', 5)),
        'smooth_window': max(1, env_int('PSEUDO_LIVE_SMOOTH_WINDOW', 12)),
        'density_reference': max(1.0, env_float('PSEUDO_LIVE_DENSITY_REFERENCE', 10.0)),
        'inference_width': max(64, env_int('PSEUDO_LIVE_INFERENCE_WIDTH', 640)),
        'inference_height': max(64, env_int('PSEUDO_LIVE_INFERENCE_HEIGHT', 360)),
        'tracker_max_age': max(1, env_int('PSEUDO_LIVE_TRACKER_MAX_AGE', 20)),
        'scale_factor': max(0.0001, env_float('PSEUDO_LIVE_SCALE_FACTOR', 0.05)),
        'speed_multiplier': max(0.1, env_float('PSEUDO_LIVE_SPEED_MULTIPLIER', 1.0)),
        'retry_sec': max(0.5, env_float('PSEUDO_LIVE_RETRY_SEC', 2.0)),
        'write_interval_sec': max(0.1, env_float('PSEUDO_LIVE_WRITE_INTERVAL_SEC', 0.5)),
        'lane_widths': lane_widths,
    }

    try:
        modules = load_modules(enable_tracking=env_bool('PSEUDO_LIVE_ENABLE_TRACKING', True))
    except Exception as exc:
        payload = build_idle_state(camera_urls, state_file, str(exc))
        write_state(state_file, payload)
        print(str(exc), file=sys.stderr)
        return 1

    print('Lane width configuration (metres):')
    for i, w in enumerate(lane_widths, start=1):
        cap = max(1.0, w * VEHICLES_PER_METER_WIDTH)
        print(f'  Lane {i}: {w:.1f} m → capacity ≈ {cap:.1f} vehicles')

    workers = [LaneWorker(idx, raw, config, modules) for idx, raw in enumerate(camera_urls, start=1)]
    for worker in workers:
        worker.open_capture()

    # Attempt to load safety monitor
    safety_monitor = None
    try:
        from safety_xai.safety_monitor import SafetyMonitor
        safety_monitor = SafetyMonitor(
            num_lanes=sum(1 for u in camera_urls if u),
            lane_widths=[lane_widths[i] for i, u in enumerate(camera_urls) if u],
        )
    except Exception:
        pass

    last_write_at = 0.0
    while RUNNING:
        now = time.time()
        changed = False
        for worker in workers:
            changed = worker.maybe_process(now) or changed

        if changed or now - last_write_at >= config['write_interval_sec']:
            lane_states = [w.to_state() for w in workers]

            # Safety monitor check
            safety_info = None
            if safety_monitor:
                try:
                    queues = [s.get('smoothedVehicleCount', 0) for s in lane_states]
                    ped_conflicts = [bool(s.get('pedestrianCount', 0) > 0) for s in lane_states]
                    emerg = [bool(s.get('emergencyDetected', False)) for s in lane_states]
                    congs = [s.get('congestionNorm') or 0 for s in lane_states]
                    chosen_idx = int(congs.index(max(congs))) if congs else 0
                    safe_action, log = safety_monitor.check(
                        proposed_action=chosen_idx,
                        queues=queues,
                        pedestrian_conflicts=ped_conflicts,
                        emergency_lanes=emerg,
                    )
                    safety_info = log.to_dict()
                    safety_info['avgSafetyScore'] = safety_monitor.avg_safety_score()
                except Exception:
                    pass

            payload = {
                'mode': 'pseudo-live',
                'running': True,
                'updatedAt': utc_now_iso(),
                'stateFile': str(state_file),
                'trackingEnabled': modules['tracking_enabled'],
                'congestionModel': {
                    'formula': 'smoothedVehicleCount / (laneWidthM × VEHICLES_PER_METER_WIDTH)',
                    'vehiclesPerMeterWidth': VEHICLES_PER_METER_WIDTH,
                    'defaultLaneWidthM': DEFAULT_LANE_WIDTH_M,
                },
                'safetyMonitor': safety_info,
                'lanes': lane_states,
            }
            write_state(state_file, payload)
            last_write_at = now
        time.sleep(0.01)

    # Final state on shutdown
    payload = {
        'mode': 'pseudo-live',
        'running': False,
        'updatedAt': utc_now_iso(),
        'stateFile': str(state_file),
        'trackingEnabled': modules['tracking_enabled'],
        'congestionModel': {
            'formula': 'smoothedVehicleCount / (laneWidthM × VEHICLES_PER_METER_WIDTH)',
            'vehiclesPerMeterWidth': VEHICLES_PER_METER_WIDTH,
            'defaultLaneWidthM': DEFAULT_LANE_WIDTH_M,
        },
        'lanes': [w.to_state() for w in workers],
    }
    write_state(state_file, payload)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())