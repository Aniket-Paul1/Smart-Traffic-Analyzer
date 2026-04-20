# Smart Traffic Web Console

This web app is the operator dashboard for the traffic project.

## What changed

- Lane decisions now come from **pseudo-live video analysis** instead of pre-generated CSV replay logs.
- The backend reads the same `VITE_CAMERA_URLS` lane list that the frontend uses.
- A Python analyzer (`pseudo_live_detection_service.py`) reads the configured videos/streams directly, runs YOLO lane analysis, and writes shared live state for the Node API.
- Route planning and parking lookup can now use your own map/geolocation provider through `.env`.

## Prerequisites

- Node.js 20+ recommended
- Python 3.10+ available on PATH, or set `PYTHON_BIN` in `traffic-web/.env`
- Python packages from the root `requirements.txt`

## Configure

Edit [traffic-web/.env](C:/Users/ANIKET/OneDrive/Desktop/Adi/a_traffic/traffic-web/.env):

- `VITE_CAMERA_URLS`: up to 9 local files or stream URLs
- `JWT_SECRET`: long random secret for auth
- `ADMIN_BOOTSTRAP_EMAIL`: optional first admin email
- `GEO_ROUTE_API_URL`, `GEO_PARKING_API_URL`, `GEO_API_KEY`: optional external map provider
- `PSEUDO_LIVE_*`: analyzer tuning

Use [traffic-web/.env.example](C:/Users/ANIKET/OneDrive/Desktop/Adi/a_traffic/traffic-web/.env.example) as a template for new setups.

## Run

From `traffic-web`:

```bash
npm run server
```

This starts the Node API and attempts to auto-start the Python pseudo-live analyzer.

In another terminal:

```bash
npm run dev
```

Open the Vite app, sign up or log in, and the dashboard will begin polling pseudo-live lane state.

## Notes

- If Python is missing, the API will still start, but live lane decisions will stay in a warming-up state until the analyzer can run.
- If you use local files, longer videos reduce visible looping in pseudo-live playback.
- The route planner and parking modules fall back to demo data when no external provider URL is configured.
