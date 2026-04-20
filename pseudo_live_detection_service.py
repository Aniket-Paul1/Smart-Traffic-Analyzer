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
RUNNING = True


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
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def camera_urls_from_env(max_lanes: int = 9) -> List[str]:
    raw = str(os.getenv('VITE_CAMERA_URLS', '')).strip()
    if not raw:
        return [''] * max_lanes
    parts = [part.strip() for part in raw.split(',')]
    while len(parts) < max_lanes:
        parts.append('')
    return parts[:max_lanes]


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
    lower = source.lower()
    return lower.startswith(('rtsp://', 'http://', 'https://'))


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
        self.cap = None
        self.fps = 20.0
        self.next_frame_at = 0.0
        self.next_retry_at = 0.0
        self.frame_idx = 0
        self.prev_dets = []
        self.density_hist = deque(maxlen=config['smooth_window'])
        self.prev_centroid = {}
        self.track_speeds = defaultdict(list)
        self.error = None
        self.available = False
        self.vehicle_count = 0
        self.smoothed_vehicle_count = 0.0
        self.avg_speed_kmh = 0.0
        self.observed_peak = float(config['density_reference'])
        self.updated_at = None
        self.tracker = self.tracker_cls(max_age=config['tracker_max_age']) if self.tracking_enabled and self.tracker_cls else None

    def open_capture(self) -> bool:
        if not self.configured:
            self.available = False
            self.error = 'Lane source is not configured.'
            return False
        if not self.resolved_source:
            self.available = False
            self.error = 'Lane source could not be resolved.'
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
            self.available = False
            self.error = 'Lane source is not configured.'
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
                    if cls not in VEHICLE_CLASSES:
                        continue
                    dets.append((
                        [
                            int(x1 * scale_x),
                            int(y1 * scale_y),
                            int(x2 * scale_x),
                            int(y2 * scale_y),
                        ],
                        float(conf),
                        cls,
                    ))
                self.prev_dets = dets
                self.error = None
            except Exception as exc:
                self.error = f'Inference failed: {exc}'

        vehicle_count = 0
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
                active_ids.add(track.track_id)
                vehicle_count += 1
                lx, ly, w, h = track.to_ltwh()
                cx = int(lx + w / 2)
                cy = int(ly + h / 2)
                if track.track_id in self.prev_centroid:
                    px, py = self.prev_centroid[track.track_id]
                    dist_pix = math.hypot(cx - px, cy - py)
                    speed_mps = dist_pix * self.config['scale_factor'] * self.fps / max(1, self.config['skip_frames'])
                    speed_kmh = speed_mps * 3.6
                    self.track_speeds[track.track_id].append(speed_kmh)
                    lane_speeds.append(speed_kmh)
                self.prev_centroid[track.track_id] = (cx, cy)
            avg_speed_kmh = float(sum(lane_speeds) / len(lane_speeds)) if lane_speeds else 0.0
            self.prev_centroid = {track_id: self.prev_centroid[track_id] for track_id in active_ids if track_id in self.prev_centroid}
        else:
            vehicle_count = len(dets)

        self.vehicle_count = int(vehicle_count)
        self.density_hist.append(float(vehicle_count))
        self.smoothed_vehicle_count = float(sum(self.density_hist) / len(self.density_hist)) if self.density_hist else 0.0
        self.avg_speed_kmh = avg_speed_kmh
        self.observed_peak = max(self.observed_peak, self.smoothed_vehicle_count, float(self.config['density_reference']))
        self.updated_at = utc_now_iso()
        self.available = True
        return True

    def to_state(self) -> dict:
        congestion_norm = None
        if self.configured:
            denominator = max(self.observed_peak, float(self.config['density_reference']), 1.0)
            congestion_norm = max(0.0, min(1.0, self.smoothed_vehicle_count / denominator))
        return {
            'id': self.id,
            'name': self.name,
            'source': self.raw_source or None,
            'resolvedSource': self.resolved_source,
            'configured': self.configured,
            'available': self.available,
            'vehicleCount': self.vehicle_count,
            'smoothedVehicleCount': round(self.smoothed_vehicle_count, 3),
            'avgSpeedKmh': round(self.avg_speed_kmh, 3),
            'observedPeak': round(self.observed_peak, 3),
            'congestionNorm': round(congestion_norm, 4) if congestion_norm is not None else None,
            'updatedAt': self.updated_at,
            'frameIndex': self.frame_idx,
            'error': self.error,
        }


def build_idle_state(camera_urls: List[str], state_file: Path, error: Optional[str] = None) -> dict:
    lanes = []
    for idx, raw_source in enumerate(camera_urls, start=1):
        resolved = resolve_source(raw_source) if raw_source else None
        lanes.append({
            'id': idx,
            'name': f'Lane {idx}',
            'source': raw_source or None,
            'resolvedSource': resolved,
            'configured': bool(raw_source),
            'available': False,
            'vehicleCount': 0,
            'smoothedVehicleCount': 0,
            'avgSpeedKmh': 0,
            'observedPeak': 0,
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
    }


def install_signal_handlers():
    def _handle_signal(_signum, _frame):
        global RUNNING
        RUNNING = False

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


def load_modules(enable_tracking: bool):
    try:
        import cv2
        import numpy as np
        from ultralytics import YOLO
    except Exception as exc:
        raise RuntimeError(f'Missing runtime dependency for pseudo-live analysis: {exc}') from exc

    tracker_cls = None
    tracking_enabled = False
    if enable_tracking:
        try:
            from deep_sort_realtime.deepsort_tracker import DeepSort
            tracker_cls = DeepSort
            tracking_enabled = True
        except Exception as exc:
            print(f'DeepSort unavailable, falling back to raw detection counts: {exc}', file=sys.stderr)

    weights_path = os.getenv('PSEUDO_LIVE_MODEL_WEIGHTS', 'yolov8n.pt')
    model = YOLO(str((ROOT_DIR / weights_path).resolve()) if not Path(weights_path).is_absolute() else weights_path)
    return {
        'cv2': cv2,
        'np': np,
        'model': model,
        'tracker_cls': tracker_cls,
        'tracking_enabled': tracking_enabled,
    }


def main() -> int:
    load_env_files(DEFAULT_ENV_FILES)
    install_signal_handlers()

    state_file = Path(os.getenv('PSEUDO_LIVE_STATE_FILE', str(DEFAULT_STATE_FILE))).resolve()
    camera_urls = camera_urls_from_env()
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
    }

    try:
        modules = load_modules(enable_tracking=env_bool('PSEUDO_LIVE_ENABLE_TRACKING', True))
    except Exception as exc:
        payload = build_idle_state(camera_urls, state_file, str(exc))
        write_state(state_file, payload)
        print(str(exc), file=sys.stderr)
        return 1

    workers = [LaneWorker(idx, raw_source, config, modules) for idx, raw_source in enumerate(camera_urls, start=1)]
    for worker in workers:
        worker.open_capture()

    last_write_at = 0.0
    while RUNNING:
        now = time.time()
        changed = False
        for worker in workers:
            changed = worker.maybe_process(now) or changed

        if changed or now - last_write_at >= config['write_interval_sec']:
            payload = {
                'mode': 'pseudo-live',
                'running': True,
                'updatedAt': utc_now_iso(),
                'stateFile': str(state_file),
                'trackingEnabled': modules['tracking_enabled'],
                'lanes': [worker.to_state() for worker in workers],
            }
            write_state(state_file, payload)
            last_write_at = now
        time.sleep(0.01)

    payload = {
        'mode': 'pseudo-live',
        'running': False,
        'updatedAt': utc_now_iso(),
        'stateFile': str(state_file),
        'trackingEnabled': modules['tracking_enabled'],
        'lanes': [worker.to_state() for worker in workers],
    }
    write_state(state_file, payload)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
