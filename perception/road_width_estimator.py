"""
perception/road_width_estimator.py

Road Width Estimation via Inverse Perspective Mapping (IPM)
============================================================
Pipeline
--------
1. Run semantic segmentation (YOLO-seg or lightweight CNN) to extract the
   drivable / road mask from the frame.
2. Apply Inverse Perspective Mapping (IPM) to obtain a bird's-eye-view (BEV)
   of the road.
3. Measure the pixel width of the road lane in the BEV image.
4. Convert pixel width → real-world metres using a calibration constant or
   lane-marking reference.

The output is used by the congestion model:
    congestionNorm = vehicleCount / (laneWidthM × VEHICLES_PER_METRE_WIDTH)

This module works even without a GPU: it falls back to classical HSV-based
road segmentation when the segmentation model is unavailable.

Usage
-----
    estimator = RoadWidthEstimator(calibration_m_per_px=0.025)
    result = estimator.estimate(frame)
    print(result.lane_width_m)           # e.g. 3.7
    annotated = estimator.draw(frame, result)
"""

from __future__ import annotations

import dataclasses
import warnings
from typing import Optional, Tuple

import cv2
import numpy as np

try:
    from ultralytics import YOLO as _YOLO
    _HAS_YOLO = True
except ImportError:
    _HAS_YOLO = False

# ---------------------------------------------------------------------------
# Default IPM homography parameters (tune per camera installation).
# These map from a standard 640×360 forward-facing camera at ~4 m height,
# 10° downward tilt to a BEV canvas of 300×300 pixels.
# ---------------------------------------------------------------------------
_DEFAULT_SRC_POINTS = np.float32([
    [160, 230],   # top-left of trapezoid in camera view
    [480, 230],   # top-right
    [620, 340],   # bottom-right
    [ 20, 340],   # bottom-left
])
_DEFAULT_DST_POINTS = np.float32([
    [ 80,   0],
    [220,   0],
    [220, 300],
    [ 80, 300],
])
_BEV_SIZE = (300, 300)   # (width, height) of bird's-eye-view canvas


@dataclasses.dataclass
class WidthEstimateResult:
    """Per-frame road width estimation result."""
    lane_width_m: float            # estimated lane width in metres (0 if failed)
    lane_width_px: float           # pixel width in BEV image
    confidence: float              # 0–1, higher = more reliable measurement
    road_mask: Optional[np.ndarray] = None   # H×W uint8 mask, optional
    bev_image: Optional[np.ndarray] = None   # BEV canvas (debug)
    method: str = "ipm"            # "ipm" | "classical" | "fallback"


class RoadWidthEstimator:
    """
    Estimates lane width from a single forward-facing camera frame.

    Parameters
    ----------
    calibration_m_per_px : float
        Metres per pixel in the BEV image.  Default 0.025 = 300 px spans ~7.5 m.
    seg_model_path : str or None
        Path to a YOLO-seg .pt weights file.  If None, use classical HSV segmentation.
    src_points : np.ndarray (4, 2) or None
        Custom IPM source trapezoid in camera coordinates.
    dst_points : np.ndarray (4, 2) or None
        Custom IPM destination rectangle in BEV coordinates.
    bev_size : tuple (W, H)
        Size of the BEV canvas in pixels.
    device : str
        "cpu" or "cuda" for the segmentation model.
    """

    def __init__(
        self,
        calibration_m_per_px: float = 0.025,
        seg_model_path: Optional[str] = None,
        src_points: Optional[np.ndarray] = None,
        dst_points: Optional[np.ndarray] = None,
        bev_size: Tuple[int, int] = _BEV_SIZE,
        device: str = "cpu",
    ) -> None:
        self.calibration_m_per_px = float(calibration_m_per_px)
        self.bev_size = bev_size
        self.device = device

        src = src_points if src_points is not None else _DEFAULT_SRC_POINTS
        dst = dst_points if dst_points is not None else _DEFAULT_DST_POINTS
        self._H, _ = cv2.findHomography(src, dst)  # camera → BEV
        self._H_inv = np.linalg.inv(self._H)       # BEV → camera

        # Attempt to load segmentation model.
        self._seg_model = None
        if seg_model_path and _HAS_YOLO:
            try:
                self._seg_model = _YOLO(seg_model_path)
                self._seg_model.to(device)
            except Exception as exc:
                warnings.warn(f"RoadWidthEstimator: could not load seg model: {exc}. "
                              "Using classical HSV segmentation fallback.")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def estimate(self, frame: np.ndarray) -> WidthEstimateResult:
        """
        Run width estimation on a single BGR frame.

        Returns a :class:`WidthEstimateResult` with lane_width_m set to 0
        if estimation failed.
        """
        if frame is None or frame.size == 0:
            return WidthEstimateResult(lane_width_m=0.0, lane_width_px=0.0, confidence=0.0)

        h_orig, w_orig = frame.shape[:2]
        # Work on a fixed inference size for speed.
        inf_w, inf_h = 640, 360
        frame_resized = cv2.resize(frame, (inf_w, inf_h))

        road_mask = self._segment_road(frame_resized)
        bev = self._warp_to_bev(road_mask)
        width_px, confidence = self._measure_width_in_bev(bev)
        width_m = width_px * self.calibration_m_per_px

        return WidthEstimateResult(
            lane_width_m=round(float(width_m), 3),
            lane_width_px=round(float(width_px), 1),
            confidence=round(float(confidence), 3),
            road_mask=road_mask,
            bev_image=bev,
            method="ipm" if self._seg_model else "classical",
        )

    def draw(self, frame: np.ndarray, result: WidthEstimateResult) -> np.ndarray:
        """
        Overlay road width annotation on *frame* (BGR).
        Returns the annotated frame.
        """
        out = frame.copy()
        h, w = out.shape[:2]

        if result.road_mask is not None:
            # Overlay semi-transparent road mask in cyan.
            mask_resized = cv2.resize(result.road_mask, (w, h))
            tint = np.zeros_like(out, dtype=np.uint8)
            tint[:, :, 1] = mask_resized  # green channel
            tint[:, :, 2] = mask_resized  # red channel → cyan
            out = cv2.addWeighted(out, 0.75, tint, 0.25, 0)

        # Draw IPM source trapezoid.
        scale_x, scale_y = w / 640, h / 360
        pts = _DEFAULT_SRC_POINTS.copy()
        pts[:, 0] *= scale_x
        pts[:, 1] *= scale_y
        cv2.polylines(out, [pts.astype(np.int32)], True, (0, 255, 255), 2)

        # Width annotation text.
        label = (
            f"Lane width: {result.lane_width_m:.2f} m  "
            f"[conf {result.confidence:.0%}]"
            if result.lane_width_m > 0
            else "Width: N/A"
        )
        cv2.putText(out, label, (10, h - 14), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (0, 255, 255), 2, cv2.LINE_AA)
        return out

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _segment_road(self, frame: np.ndarray) -> np.ndarray:
        """
        Returns a uint8 binary mask (0 or 255) of the road region.
        Uses YOLO-seg if available, otherwise classical HSV thresholding.
        """
        if self._seg_model is not None:
            return self._yolo_seg_mask(frame)
        return self._classical_road_mask(frame)

    def _yolo_seg_mask(self, frame: np.ndarray) -> np.ndarray:
        """Run YOLO-seg; class 0 is typically 'road' in road segmentation models."""
        h, w = frame.shape[:2]
        try:
            results = self._seg_model(frame, verbose=False)[0]
            if results.masks is None:
                return self._classical_road_mask(frame)
            # Combine all road-class masks.
            combined = np.zeros((h, w), dtype=np.uint8)
            masks_data = results.masks.data.cpu().numpy()  # (N, H', W')
            for i, cls_id in enumerate(results.boxes.cls.cpu().numpy().astype(int)):
                if cls_id == 0:  # road class
                    m = cv2.resize((masks_data[i] > 0.5).astype(np.uint8) * 255, (w, h))
                    combined = cv2.bitwise_or(combined, m)
            if combined.max() == 0:
                return self._classical_road_mask(frame)
            return combined
        except Exception:
            return self._classical_road_mask(frame)

    @staticmethod
    def _classical_road_mask(frame: np.ndarray) -> np.ndarray:
        """
        HSV-based road segmentation.
        Roads are typically dark grey / asphalt or light concrete.
        We threshold on low-saturation pixels in a lower-half ROI.
        """
        h, w = frame.shape[:2]
        # Focus on lower 60% of frame where the road surface is.
        roi = frame[int(h * 0.4):, :]
        blurred = cv2.GaussianBlur(roi, (7, 7), 0)
        hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)

        # Asphalt: low saturation, moderate value (50–180).
        sat = hsv[:, :, 1]
        val = hsv[:, :, 2]
        road_region = ((sat < 60) & (val > 40) & (val < 210)).astype(np.uint8) * 255

        # Morphological clean-up.
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        road_region = cv2.morphologyEx(road_region, cv2.MORPH_CLOSE, kernel)
        road_region = cv2.morphologyEx(road_region, cv2.MORPH_OPEN, kernel)

        # Paste back into full-frame mask.
        full_mask = np.zeros((h, w), dtype=np.uint8)
        full_mask[int(h * 0.4):, :] = road_region
        return full_mask

    def _warp_to_bev(self, mask: np.ndarray) -> np.ndarray:
        """Apply IPM homography to produce a bird's-eye-view of the road mask."""
        bev = cv2.warpPerspective(
            mask, self._H, self.bev_size, flags=cv2.INTER_LINEAR
        )
        return bev

    @staticmethod
    def _measure_width_in_bev(bev: np.ndarray) -> Tuple[float, float]:
        """
        Measure the horizontal extent of the road in the BEV mask.

        Strategy: scan horizontal lines in the middle band, find leftmost and
        rightmost road pixels, average across the band.

        Returns (width_px, confidence).
        """
        h, w = bev.shape[:2]
        mid_y_start = int(h * 0.4)
        mid_y_end = int(h * 0.6)
        band = bev[mid_y_start:mid_y_end, :]

        widths = []
        for row in band:
            road_px = np.where(row > 127)[0]
            if len(road_px) >= 10:
                widths.append(float(road_px[-1] - road_px[0]))

        if not widths:
            return 0.0, 0.0

        median_w = float(np.median(widths))
        # Confidence: fraction of rows that had road pixels, capped at 1.
        confidence = min(1.0, len(widths) / max(1, mid_y_end - mid_y_start))
        return median_w, confidence
