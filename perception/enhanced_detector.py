"""
perception/enhanced_detector.py

Enhanced YOLOv11 Detector
=========================
Detects vehicles, pedestrians, cyclists, and emergency vehicles.
Uses YOLOv11 (latest Ultralytics) for higher precision than v8.
Returns rich per-frame state including class breakdown and conflict flags.

Model weights are downloaded automatically by Ultralytics on first run:
    yolo11n.pt  — nano  (fastest, least accurate)
    yolo11s.pt  — small (recommended balance)
    yolo11m.pt  — medium
    yolo11l.pt  — large (most accurate, needs GPU)

Set env variable PSEUDO_LIVE_MODEL_WEIGHTS=yolo11s.pt for better precision.
"""

from __future__ import annotations

import dataclasses
import math
from collections import defaultdict, deque
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

try:
    from ultralytics import YOLO
    _HAS_YOLO = True
except ImportError:
    _HAS_YOLO = False

try:
    from deep_sort_realtime.deepsort_tracker import DeepSort
    _HAS_DEEPSORT = True
except ImportError:
    _HAS_DEEPSORT = False

# ---------------------------------------------------------------------------
# Class ID mappings (COCO)
# ---------------------------------------------------------------------------
VEHICLE_CLASSES: Dict[int, str] = {
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}
PEDESTRIAN_CLASS = 0       # "person"
CYCLIST_CLASS = 1          # "bicycle"
# Emergency vehicles are detected by class + confidence heuristic
# (bus/truck with high conf at low speed proxy); fine-tune on domain data
EMERGENCY_CONF_THRESHOLD = 0.82

ALL_DETECTION_CLASSES = set(VEHICLE_CLASSES.keys()) | {PEDESTRIAN_CLASS, CYCLIST_CLASS}


@dataclasses.dataclass
class Detection:
    track_id: int
    cls_id: int
    cls_name: str
    bbox: Tuple[int, int, int, int]   # x1, y1, x2, y2
    conf: float
    speed_kmh: float
    is_emergency: bool


@dataclasses.dataclass
class FrameState:
    """Rich per-frame state for one lane."""
    frame_idx: int
    timestamp: float
    vehicle_count: int
    pedestrian_count: int
    cyclist_count: int
    emergency_count: int
    avg_speed_kmh: float
    detections: List[Detection]
    pedestrian_conflict: bool          # pedestrians near active lane edge
    emergency_detected: bool


class EnhancedDetector:
    """
    YOLOv8-based detector with DeepSort tracking.

    Parameters
    ----------
    model_weights : str
        Path to YOLOv8 .pt file.
    inference_size : tuple (W, H)
    skip_frames : int
        Run YOLO every N frames; reuse previous detections in between.
    smooth_window : int
        Moving average window for speed / count smoothing.
    scale_factor : float
        Metres per pixel for speed estimation.
    tracker_max_age : int
        DeepSort max_age parameter.
    device : str
        "cpu" or "cuda".
    """

    def __init__(
        self,
        model_weights: str = "yolo11s.pt",   # YOLOv11 small — better precision than nano
        inference_size: Tuple[int, int] = (640, 360),
        skip_frames: int = 5,
        smooth_window: int = 12,
        scale_factor: float = 0.05,
        tracker_max_age: int = 20,
        device: str = "cpu",
    ) -> None:
        self.inference_w, self.inference_h = inference_size
        self.skip_frames = skip_frames
        self.scale_factor = scale_factor

        if not _HAS_YOLO:
            raise RuntimeError("ultralytics is required: pip install ultralytics")
        self.model = YOLO(model_weights)
        self.model.to(device)

        if _HAS_DEEPSORT:
            self.tracker = DeepSort(max_age=tracker_max_age)
        else:
            self.tracker = None

        # Per-track history
        self._prev_centroids: Dict[int, Tuple[int, int]] = {}
        self._speed_hist: Dict[int, deque] = defaultdict(lambda: deque(maxlen=smooth_window))
        self._count_hist: deque = deque(maxlen=smooth_window)
        self._prev_dets: list = []
        self._frame_idx: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process_frame(self, frame: np.ndarray, fps: float = 30.0) -> FrameState:
        """Process a single BGR frame and return FrameState."""
        self._frame_idx += 1
        timestamp = self._frame_idx / max(1.0, fps)
        h_orig, w_orig = frame.shape[:2]

        frame_inf = cv2.resize(frame, (self.inference_w, self.inference_h))
        scale_x = w_orig / self.inference_w
        scale_y = h_orig / self.inference_h

        # Run YOLO every skip_frames frames
        if self._frame_idx % self.skip_frames == 0:
            results = self.model(frame_inf, verbose=False)[0]
            raw_dets = []
            for box in results.boxes.data:
                x1, y1, x2, y2, conf, cls = box
                cls = int(cls)
                if cls not in ALL_DETECTION_CLASSES:
                    continue
                raw_dets.append((
                    [int(x1 * scale_x), int(y1 * scale_y),
                     int(x2 * scale_x), int(y2 * scale_y)],
                    float(conf),
                    cls,
                ))
            self._prev_dets = raw_dets
        else:
            raw_dets = self._prev_dets

        # Tracking
        tracked = self._run_tracker(raw_dets, frame)
        detections, speeds = self._build_detections(tracked, fps)

        # Aggregate stats
        vehicle_count = sum(1 for d in detections if d.cls_id in VEHICLE_CLASSES)
        ped_count = sum(1 for d in detections if d.cls_id == PEDESTRIAN_CLASS)
        cyclist_count = sum(1 for d in detections if d.cls_id == CYCLIST_CLASS)
        emergency_count = sum(1 for d in detections if d.is_emergency)

        self._count_hist.append(vehicle_count)
        avg_speed = float(np.mean(speeds)) if speeds else 0.0
        ped_conflict = ped_count > 0  # simplification: any pedestrian = conflict risk

        return FrameState(
            frame_idx=self._frame_idx,
            timestamp=timestamp,
            vehicle_count=vehicle_count,
            pedestrian_count=ped_count,
            cyclist_count=cyclist_count,
            emergency_count=emergency_count,
            avg_speed_kmh=round(avg_speed, 2),
            detections=detections,
            pedestrian_conflict=ped_conflict,
            emergency_detected=emergency_count > 0,
        )

    def smoothed_vehicle_count(self) -> float:
        if not self._count_hist:
            return 0.0
        return float(np.mean(self._count_hist))

    def draw_detections(self, frame: np.ndarray, state: FrameState) -> np.ndarray:
        """Draw bounding boxes and labels on frame."""
        out = frame.copy()
        for det in state.detections:
            x1, y1, x2, y2 = det.bbox
            color = (
                (0, 0, 255) if det.is_emergency else
                (0, 165, 255) if det.cls_id == PEDESTRIAN_CLASS else
                (255, 200, 0) if det.cls_id == CYCLIST_CLASS else
                (0, 255, 0)
            )
            cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
            label = f"{det.cls_name} #{det.track_id} {det.speed_kmh:.0f}km/h"
            if det.is_emergency:
                label = f"EMERG {label}"
            cv2.putText(out, label, (x1, max(y1 - 6, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
        return out

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _run_tracker(self, raw_dets: list, frame: np.ndarray) -> list:
        if self.tracker is None:
            # Fake tracker: assign sequential IDs without real tracking
            return [(i, det[0], det[1], det[2]) for i, det in enumerate(raw_dets)]
        try:
            outputs = self.tracker.update_tracks(raw_dets, frame=frame)
            result = []
            for tr in outputs:
                if not tr.is_confirmed():
                    continue
                lx, ly, w, h = tr.to_ltwh()
                bbox = [int(lx), int(ly), int(lx + w), int(ly + h)]
                det_cls = int(tr.det_class) if tr.det_class is not None else 2
                result.append((tr.track_id, bbox, tr.det_conf or 0.5, det_cls))
            return result
        except Exception:
            return []

    def _build_detections(
        self,
        tracked: list,
        fps: float,
    ) -> Tuple[List[Detection], List[float]]:
        detections: List[Detection] = []
        speeds: List[float] = []

        for item in tracked:
            track_id, bbox, conf, cls_id = item
            x1, y1, x2, y2 = bbox
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

            # Speed estimation
            speed_kmh = 0.0
            if track_id in self._prev_centroids:
                px, py = self._prev_centroids[track_id]
                dist_px = math.hypot(cx - px, cy - py)
                speed_mps = dist_px * self.scale_factor * fps / max(1, self.skip_frames)
                speed_kmh = speed_mps * 3.6
            self._prev_centroids[track_id] = (cx, cy)
            self._speed_hist[track_id].append(speed_kmh)
            smooth_speed = float(np.mean(self._speed_hist[track_id]))
            speeds.append(smooth_speed)

            cls_name = VEHICLE_CLASSES.get(cls_id,
                       "pedestrian" if cls_id == PEDESTRIAN_CLASS else
                       "cyclist" if cls_id == CYCLIST_CLASS else "unknown")

            # Emergency heuristic: large vehicle (bus/truck) + high confidence
            is_emergency = (cls_id in (5, 7)) and conf >= EMERGENCY_CONF_THRESHOLD

            detections.append(Detection(
                track_id=int(track_id),
                cls_id=cls_id,
                cls_name=cls_name,
                bbox=(x1, y1, x2, y2),
                conf=round(float(conf), 3),
                speed_kmh=round(smooth_speed, 2),
                is_emergency=is_emergency,
            ))

        return detections, speeds