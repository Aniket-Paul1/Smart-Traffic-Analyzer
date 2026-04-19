# detection_tracker_multi_lane.py
import cv2, os, math, time, glob
import numpy as np
import pandas as pd
from ultralytics import YOLO
from deep_sort_realtime.deepsort_tracker import DeepSort
from collections import defaultdict

# -------------------- CONFIG --------------------
# Use project-relative path to avoid Windows backslash escape issues.
VIDEO_FOLDER = os.path.join(os.path.dirname(__file__), "traffic-web", "public", "videos")  # folder containing all mp4 videos
OUTPUT_DIR = "logs"             # folder to save CSV logs
MODEL_WEIGHTS = "yolov8n.pt"    # YOLO model
VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
SCALE_FACTOR = 0.05             # meters per pixel for speed

# Lane ROIs in ORIGINAL video coordinates: (x1, y1, x2, y2)
# IMPORTANT: Tune these to your camera setup.
#
# Default keeps your previous single ROI behavior (1 lane output).
LANE_ROIS = [
    (50, 200, 1600, 600),
]

NUM_LANES = len(LANE_ROIS)

INFERENCE_WIDTH = 640
INFERENCE_HEIGHT = 360
SKIP_FRAMES = 5

# -------------------- SETUP --------------------
os.makedirs(OUTPUT_DIR, exist_ok=True)
video_files = glob.glob(os.path.join(VIDEO_FOLDER, "*.mp4"))
if not video_files:
    raise ValueError(f"No .mp4 videos found in '{VIDEO_FOLDER}'")

print(f" Found {len(video_files)} video(s) in '{VIDEO_FOLDER}'")
model = YOLO(MODEL_WEIGHTS)
print(f" YOLO model loaded ({MODEL_WEIGHTS}) | Device: {model.device}")

# -------------------- PROCESS ALL VIDEOS --------------------
start_all = time.time()
summary = []

for VIDEO_SOURCE in video_files:
    print(f"\n Processing {os.path.basename(VIDEO_SOURCE)} ...")
    cap = cv2.VideoCapture(VIDEO_SOURCE)
    if not cap.isOpened():
        print(f" Skipping {VIDEO_SOURCE} (cannot open file)")
        continue

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    frame_idx = 0
    frame_time = 1.0 / fps

    prev_centroid = {}
    track_speeds = defaultdict(list)
    rows = []
    prev_dets = []
    tracker = DeepSort(max_age=30)
    start_time = time.time()

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        timestamp = frame_idx / fps

        frame_resized = cv2.resize(frame, (INFERENCE_WIDTH, INFERENCE_HEIGHT))

        # --- YOLO inference every SKIP_FRAMES ---
        if frame_idx % SKIP_FRAMES == 0:
            results = model(frame_resized, verbose=False)[0]
            dets = []
            for box in results.boxes.data:
                x1, y1, x2, y2, conf, cls = box
                cls = int(cls)
                if cls in VEHICLE_CLASSES:
                    scale_x = frame.shape[1] / INFERENCE_WIDTH
                    scale_y = frame.shape[0] / INFERENCE_HEIGHT
                    dets.append((
                        [int(x1 * scale_x), int(y1 * scale_y), int(x2 * scale_x), int(y2 * scale_y)],
                        float(conf),
                        cls
                    ))
            prev_dets = dets
        else:
            dets = prev_dets

        # --- Tracker update ---
        outputs = tracker.update_tracks(dets, frame=frame)
        lane_tracks = [set() for _ in range(NUM_LANES)]
        lane_speeds = [[] for _ in range(NUM_LANES)]

        # Unpack ROI list into local variables for faster access.
        lane_rois = LANE_ROIS

        for tr in outputs:
            if not tr.is_confirmed():
                continue
            tid = tr.track_id
            lx, ly, w, h = tr.to_ltwh()
            x1, y1, x2, y2 = int(lx), int(ly), int(lx + w), int(ly + h)
            cx, cy = int((x1 + x2) / 2), int((y1 + y2) / 2)
            # Assign track to the first ROI that contains its centroid.
            lane_id = None
            for i, (rx1, ry1, rx2, ry2) in enumerate(lane_rois):
                if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                    lane_id = i
                    break
            if lane_id is None:
                continue

            lane_tracks[lane_id].add(tid)

            # Speed estimation
            speed_kmh = 0
            if tid in prev_centroid:
                px, py = prev_centroid[tid]
                dist_pix = math.hypot(cx - px, cy - py)
                speed_mps = dist_pix * SCALE_FACTOR * fps / SKIP_FRAMES
                speed_kmh = speed_mps * 3.6
                track_speeds[tid].append(speed_kmh)
                lane_speeds[lane_id].append(speed_kmh)
            prev_centroid[tid] = (cx, cy)

        row = {
            "frame_idx": frame_idx,
            "timestamp": timestamp,
        }
        for lane_id in range(NUM_LANES):
            row[f"density_lane_{lane_id}"] = len(lane_tracks[lane_id])
            row[f"avg_speed_lane_{lane_id}"] = (
                float(np.mean(lane_speeds[lane_id])) if lane_speeds[lane_id] else 0.0
            )

        # Backward compatible legacy columns when producing single-lane logs.
        if NUM_LANES == 1:
            row["density"] = row["density_lane_0"]
            row["avg_speed_lane_0"] = row["avg_speed_lane_0"]

        rows.append(row)

        # --- Progress update ---
        if frame_idx % 200 == 0 or frame_idx == total_frames:
            print(f"  Frame {frame_idx}/{total_frames} ({(frame_idx / total_frames) * 100:.1f}%)")

    cap.release()
    out_path = os.path.join(OUTPUT_DIR, os.path.splitext(os.path.basename(VIDEO_SOURCE))[0] + '_timeseries.csv')
    pd.DataFrame(rows).to_csv(out_path, index=False)
    elapsed = time.time() - start_time
    print(f" Saved {out_path} | Frames: {frame_idx} | Time: {elapsed:.1f}s")

    summary.append((os.path.basename(VIDEO_SOURCE), frame_idx, round(elapsed, 1)))

# -------------------- SUMMARY --------------------
total_time = time.time() - start_all
print("\n All videos processed successfully!")
print("─────────────────────────────────────────────")
for name, frames, t in summary:
    print(f"{name:<20}  Frames: {frames:<7}  Time: {t:>6}s")
print(f"─────────────────────────────────────────────\n Total batch time: {total_time:.1f}s")
