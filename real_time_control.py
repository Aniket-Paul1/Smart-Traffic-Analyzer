# real_time_control.py
"""
Real-time traffic control template (RL lane selection).

- Reads from webcam or IP camera
- Runs YOLO + DeepSort to compute per-lane densities
- Observation: queue/density vector shaped (num_lanes,)
- Loads trained RL model (Stable-Baselines3 DQN)
- At each decision step agent picks ONLY the lane index to give GREEN
- The script continues processing frames continuously (non-blocking display),
  and calls `apply_green_to_hardware(lane, hold_duration)` at decision times.
"""

import time
import os
import math
from collections import defaultdict, deque

import cv2
import numpy as np

from ultralytics import YOLO
from deep_sort_realtime.deepsort_tracker import DeepSort
from stable_baselines3 import DQN  # or the algorithm you used
import torch

# ---------------- CONFIG ----------------
VIDEO_SOURCE = 0  # 0 for default webcam or "http://IP:PORT/video" for RTSP/HTTP
MODEL_WEIGHTS = "yolov8n.pt"
TRACKER_MAX_AGE = 30

VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
SCALE_FACTOR = 0.05   # meters per pixel (tune this for your camera)
LANE_ROIS = [
    (50, 200, 1600, 600),  # Lane 0 (x1,y1,x2,y2) in original frame coords -> tune per camera
]
NUM_LANES = len(LANE_ROIS)
INFERENCE_W, INFERENCE_H = 640, 360
SKIP_FRAMES = 3   # skip frames between YOLO inferences to save CPU
SMOOTH_WINDOW = 5  # frames for moving average of densities/speeds

# Decision interval (frames) between agent calls.
DECIDE_EVERY_N_FRAMES = 1

MODEL_PATH = "dqn_traffic_controller.zip"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

PRINT_EVERY_N = 1  # print status every N decision steps
# ----------------------------------------

# Hardware integration placeholder
def apply_green_to_hardware(lane: int, duration: float):
    """
    Replace this with code to actually control traffic lights (GPIO, REST call, etc.)
    For simulation we just print. If using Raspberry Pi, use RPi.GPIO or gpiozero here.
    """
    print(f"[HARDWARE] Apply GREEN to lane {lane} for {duration} seconds (simulated)")

# ---------------- SETUP ----------------
print("Loading models...")
yolo = YOLO(MODEL_WEIGHTS)
tracker = DeepSort(max_age=TRACKER_MAX_AGE)
model = None
try:
    model = DQN.load(MODEL_PATH, device=DEVICE)
    print("RL model loaded. Starting video capture...")
except Exception as e:
    print(f"RL model not found or failed to load ({e}). Using baseline argmax policy.")

cap = cv2.VideoCapture(VIDEO_SOURCE)
fps = cap.get(cv2.CAP_PROP_FPS) or 20.0
frame_time = 1.0 / fps
decision_interval_sec = DECIDE_EVERY_N_FRAMES * frame_time

# For smoothing
density_hist = [deque(maxlen=SMOOTH_WINDOW) for _ in range(NUM_LANES)]

# Keep previous centroids for speed estimation
prev_centroid = {}
track_speeds = defaultdict(list)

current_green_lane = 0  # currently selected lane that should be GREEN

decision_count = 0
last_decision_time = time.time()

frame_idx = 0
prev_dets = []

try:
    while True:
        loop_start = time.time()
        ret, frame = cap.read()
        if not ret:
            print("Frame read failed, breaking.")
            break
        frame_idx += 1

        # Resize for inference but keep original for ROI coords
        frame_resized = cv2.resize(frame, (INFERENCE_W, INFERENCE_H))

        # YOLO inference every SKIP_FRAMES frames
        if frame_idx % SKIP_FRAMES == 0:
            results = yolo(frame_resized, verbose=False)[0]
            dets = []
            for box in results.boxes.data:
                x1, y1, x2, y2, conf, cls = box
                cls = int(cls)
                if cls in VEHICLE_CLASSES:
                    scale_x = frame.shape[1] / INFERENCE_W
                    scale_y = frame.shape[0] / INFERENCE_H
                    dets.append((
                        [int(x1 * scale_x), int(y1 * scale_y), int(x2 * scale_x), int(y2 * scale_y)],
                        float(conf),
                        cls
                    ))
            prev_dets = dets
        else:
            dets = prev_dets

        outputs = tracker.update_tracks(dets, frame=frame)

        # Compute per-lane densities (RL observation).
        lane_tracks = [set() for _ in range(NUM_LANES)]
        lane_speeds = [[] for _ in range(NUM_LANES)]

        for tr in outputs:
            if not tr.is_confirmed():
                continue
            tid = tr.track_id
            lx, ly, w, h = tr.to_ltwh()
            x1, y1, x2, y2 = int(lx), int(ly), int(lx + w), int(ly + h)
            cx, cy = int((x1 + x2) / 2), int((y1 + y2) / 2)

            lane_id = None
            for i, (rx1, ry1, rx2, ry2) in enumerate(LANE_ROIS):
                if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                    lane_id = i
                    break
            if lane_id is None:
                continue

            lane_tracks[lane_id].add(tid)

            # Optional speed estimation for display only.
            if tid in prev_centroid:
                px, py = prev_centroid[tid]
                dist_pix = math.hypot(cx - px, cy - py)
                speed_mps = dist_pix * SCALE_FACTOR * fps / max(1, SKIP_FRAMES)
                speed_kmh = speed_mps * 3.6
                track_speeds[tid].append(speed_kmh)
                lane_speeds[lane_id].append(speed_kmh)
            prev_centroid[tid] = (cx, cy)

        # Update smoothing buffers and build observation vector.
        smoothed_densities = []
        for lane_id in range(NUM_LANES):
            density = len(lane_tracks[lane_id])
            density_hist[lane_id].append(density)
            smoothed_densities.append(float(np.mean(density_hist[lane_id])))

        obs = np.asarray(smoothed_densities, dtype=np.float32)  # shape=(num_lanes,)

        # Decide lane every ~DECIDE_EVERY_N_FRAMES frames worth of wall-clock time.
        now = time.time()
        if now - last_decision_time >= decision_interval_sec:
            if model is not None:
                action_arr, _ = model.predict(obs, deterministic=True)
                chosen_lane = int(action_arr)
            else:
                chosen_lane = int(np.argmax(obs)) if len(obs) else 0

            chosen_lane = max(0, min(NUM_LANES - 1, chosen_lane))
            # The "duration" is the target window until the next decision.
            # Implement your hardware driver so it can apply for this time,
            # or ignore it and handle timing internally.
            apply_green_to_hardware(chosen_lane, decision_interval_sec)
            current_green_lane = chosen_lane
            last_decision_time = now

            decision_count += 1
            if decision_count % PRINT_EVERY_N == 0:
                dens_str = ", ".join([f"{d:.1f}" for d in smoothed_densities])
                print(f"[DECISION {decision_count}] lane={chosen_lane} | dens=[{dens_str}]")

        # Display overlay.
        for lane_id, (rx1, ry1, rx2, ry2) in enumerate(LANE_ROIS):
            color = (0, 255, 0) if lane_id == current_green_lane else (0, 0, 255)
            cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, 2)
            cv2.putText(
                frame,
                f"L{lane_id}: {smoothed_densities[lane_id]:.1f}",
                (rx1 + 5, ry1 - 5),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (255, 255, 255),
                2,
            )

        cv2.putText(
            frame,
            f"GREEN Lane: {current_green_lane}",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.9,
            (0, 255, 0),
            2,
        )
        cv2.imshow("Real-time Control", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

        # throttle main loop
        delay_ms = max(1, int((frame_time - (time.time() - loop_start)) * 1000))
        time.sleep(delay_ms / 1000.0)

except KeyboardInterrupt:
    print("Interrupted by user. Exiting...")

finally:
    cap.release()
    cv2.destroyAllWindows()
    print("Shut down cleanly.")
