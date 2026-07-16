# Smart Traffic Analyzer

AI-powered smart traffic management system with **zero-casualty design**, width-aware
congestion scoring, YOLOv11 detection, multi-agent RL, spatio-temporal prediction,
and a full explainability layer.

---

## Project Structure

```
Smart-Traffic-Analyzer/
├── perception/
│   ├── road_width_estimator.py     ← IPM-based lane width from camera
│   └── enhanced_detector.py        ← YOLOv11 + DeepSort (vehicles, pedestrians, emergency)
├── prediction/
│   ├── gnn_predictor.py            ← AGCRN spatio-temporal GNN
│   └── transformer_predictor.py    ← Informer-style transformer
├── control/
│   ├── reward_fn.py                ← Safety-first composite reward
│   └── mappo_agent.py              ← Multi-Agent PPO (CTDE)
├── safety_xai/
│   ├── safety_monitor.py           ← Hard safety overrides
│   └── explainer.py                ← SHAP-style importance + attention heatmap
├── utils/
│   └── config_loader.py            ← YAML config + env-variable overrides
├── config/
│   └── config.yaml                 ← Full system configuration
├── traffic-web/
│   ├── server/index.mjs            ← Express API
│   └── src/
│       ├── context/
│       │   ├── AuthContext.jsx     ← Session-only auth (sessionStorage)
│       │   └── TrafficContext.jsx
│       ├── components/
│       │   ├── ProtectedRoute.jsx  ← Role-based access control
│       │   └── dashboard/
│       │       ├── LaneCard.jsx
│       │       ├── AIDecisionPanel.jsx
│       │       ├── SafetyPanel.jsx
│       │       ├── XAIPanel.jsx
│       │       └── RoadWidthPanel.jsx
│       └── pages/
│           ├── App.jsx             ← Routing + nav (role-filtered)
│           ├── DashboardPage.jsx
│           ├── ParkingPage.jsx     ← Dedicated parking availability page
│           ├── RoutePlannerPage.jsx
│           ├── FeedbackPage.jsx
│           ├── AdminPage.jsx       ← Traffic Control (police + admin)
│           └── UsersPage.jsx       ← User management (admin only)
├── pseudo_live_detection_service.py ← YOLOv11 + width-aware + pedestrian alerts
├── traffic_env.py
├── train_rl.py
├── main.py
└── requirements.txt
```

---

## Role Access Matrix

| Page / Feature        | Local User | Traffic Police | Admin |
|-----------------------|:----------:|:--------------:|:-----:|
| Dashboard             | ✗ denied   | ✓ full         | ✓     |
| Route Planner         | ✓          | ✓              | ✓     |
| Feedback              | ✓          | ✓              | ✓     |
| Parking Availability  | ✓          | ✓              | ✓     |
| Traffic Control       | ✗ denied   | ✓              | ✓     |
| Users Management      | ✗ denied   | ✗ denied       | ✓     |

**Default landing page after login:**
- Local User → `/parking`
- Traffic Police / Admin → `/dashboard`

---

## Authentication

- Passwords required every session — tokens stored in `sessionStorage`, cleared on browser close
- No silent re-login after closing the browser
- JWT expiry: 8 hours (within a session)
- Admin account: set `ADMIN_BOOTSTRAP_EMAIL` in `.env`, delete `database.sqlite`, restart server, register with that email

---

## Congestion Formula

```
congestionScore = smoothedVehicleCount / laneCapacity
laneCapacity    = laneWidthMeters × 2.5
```

Configure lane widths in `traffic-web/.env`:
```
VITE_LANE_WIDTHS=3.5,3.5,4.0,3.0
```

---

## YOLOv11

Uses `yolo11s.pt` by default (small model, good precision/speed balance).
Weights are downloaded automatically by Ultralytics on first run.

Override in `.env`:
```
PSEUDO_LIVE_MODEL_WEIGHTS=yolo11m.pt   # medium — better accuracy
```

---

## Quick Start

```bash
# 1. Install Python deps
pip install -r requirements.txt

# 2. Configure environment
# Edit traffic-web/.env:
#   VITE_CAMERA_URLS=/videos/lane1.mp4,/videos/lane2.mp4,...
#   VITE_LANE_WIDTHS=3.5,3.5,4.0,3.0
#   JWT_SECRET=your_secret_here
#   ADMIN_BOOTSTRAP_EMAIL=your@email.com

# 3. Install Node deps
cd traffic-web && npm install

# 4. Run all three services (3 terminals or VS Code tasks)
python pseudo_live_detection_service.py     # Terminal 1 (project root)
npm run server                              # Terminal 2 (traffic-web/)
npm run dev                                 # Terminal 3 (traffic-web/)

# 5. Open http://localhost:5173
```

---

## Safety Design

- **Pedestrian detected** → alert shown in dashboard, drivers advised to yield. Green light is NOT blocked.
- **Emergency vehicle** → auto-detected from live state, priority green (90 s) assigned immediately
- **Narrow road speed** → speed penalty in RL reward, advisory logged
- **Casualty risk target: Minimal** (score ≥ 90/100)
