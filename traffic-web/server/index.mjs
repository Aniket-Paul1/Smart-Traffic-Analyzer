import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import initSqlJs from 'sql.js'
import { haversineKm, PARKING_ZONES, PLACES, parkingNearLocation, planRoutes } from './demoGeo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..')
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'traffic.db')
const ROOT_DIR = path.resolve(__dirname, '..', '..')
const LOGS_DIR = path.join(ROOT_DIR, 'logs')
const LIVE_STATE_PATH = path.join(LOGS_DIR, 'pseudo_live_state.json')
const DEFAULT_ENV_PATHS = [path.join(APP_DIR, '.env'), path.join(ROOT_DIR, '.env')]

function loadEnvFiles(paths) {
  for (const envPath of paths) {
    if (!envPath || !fs.existsSync(envPath)) continue
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const clean = line.startsWith('export ') ? line.slice(7).trim() : line
      const match = clean.match(/^([\w.-]+)\s*=\s*(.*)$/)
      if (!match) continue
      const [, key, valueRaw] = match
      if (process.env[key] != null && process.env[key] !== '') continue
      const quoted =
        (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
        (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
      process.env[key] = quoted ? valueRaw.slice(1, -1) : valueRaw
    }
  }
}

loadEnvFiles(DEFAULT_ENV_PATHS)

const JWT_SECRET = process.env.JWT_SECRET || ''
const PORT = Number(process.env.PORT) || 3001
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const GEO_ROUTE_API_URL = process.env.GEO_ROUTE_API_URL || ''
const GEO_PARKING_API_URL = process.env.GEO_PARKING_API_URL || ''
const GEO_API_KEY = process.env.GEO_API_KEY || ''
const GEO_API_KEY_HEADER = process.env.GEO_API_KEY_HEADER || 'Authorization'
const GEO_API_KEY_PREFIX = process.env.GEO_API_KEY_PREFIX ?? 'Bearer '
const GEO_PROVIDER_TIMEOUT_MS = Number(process.env.GEO_PROVIDER_TIMEOUT_MS || 12000)
const ADMIN_BOOTSTRAP_EMAIL = String(process.env.ADMIN_BOOTSTRAP_EMAIL || '').toLowerCase().trim()
const PSEUDO_LIVE_AUTO_START = !['0', 'false', 'no'].includes(String(process.env.PSEUDO_LIVE_AUTO_START || 'true').toLowerCase())
const PSEUDO_LIVE_STALE_MS = Number(process.env.PSEUDO_LIVE_STALE_MS || 8000)
const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const GOOGLE_ROUTES_COMPUTE_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const GOOGLE_PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby'

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET. Set it in traffic-web/.env before starting the server.')
}

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(LOGS_DIR, { recursive: true })

const SQL = await initSqlJs()
let db
if (fs.existsSync(DB_PATH)) {
  db = new SQL.Database(new Uint8Array(fs.readFileSync(DB_PATH)))
} else {
  db = new SQL.Database()
}

function persist() {
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
}

function scalar(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  if (!stmt.step()) {
    stmt.free()
    return undefined
  }
  const row = stmt.get()
  stmt.free()
  return row?.[0]
}

function getUserByEmail(email) {
  const stmt = db.prepare('SELECT id, email, password_hash, name, role FROM users WHERE email = ?')
  stmt.bind([email])
  if (!stmt.step()) {
    stmt.free()
    return null
  }
  const o = stmt.getAsObject()
  stmt.free()
  return o
}

function getUserById(id) {
  const stmt = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
  stmt.bind([id])
  if (!stmt.step()) {
    stmt.free()
    return null
  }
  const o = stmt.getAsObject()
  stmt.free()
  return o
}

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)
db.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_only_one_admin ON users (role) WHERE role = 'admin';
`)
db.run(`
  CREATE TABLE IF NOT EXISTS intersections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    congestion TEXT NOT NULL,
    incidents INTEGER NOT NULL DEFAULT 0
  );
`)
db.run(`
  CREATE TABLE IF NOT EXISTS saved_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    destination TEXT NOT NULL,
    eta_mins INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`)

const ixCount = Number(scalar('SELECT COUNT(*) FROM intersections') ?? 0)
if (ixCount === 0) {
  const rows = [
    ['INT-01', 'Healthy', 'Moderate', 1],
    ['INT-02', 'Critical', 'High', 4],
    ['INT-03', 'Healthy', 'Low', 0],
    ['INT-04', 'Watch', 'Medium', 2],
  ]
  for (const r of rows) {
    db.run('INSERT INTO intersections (code, status, congestion, incidents) VALUES (?, ?, ?, ?)', r)
  }
  persist()
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' },
  )
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization' })
  }
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

function authorityMiddleware(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'traffic_police') {
    return res.status(403).json({ error: 'Traffic authority access required' })
  }
  next()
}

function listUsersSafe() {
  const stmt = db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY id ASC')
  const rows = []
  while (stmt.step()) {
    const o = stmt.getAsObject()
    rows.push({
      id: Number(o.id),
      email: o.email,
      name: o.name,
      role: o.role,
      created_at: o.created_at,
    })
  }
  stmt.free()
  return rows
}

let lastServedLaneId = null
const EMPTY_THRESHOLD = 0.05
const VERY_HIGH_THRESHOLD = 0.75
const LIVE_STATE_CACHE = { mtimeMs: 0, data: null }
let pseudoLiveChild = null

function mapDurationFromCongestion(norm) {
  if (norm <= EMPTY_THRESHOLD) return 40
  if (norm >= VERY_HIGH_THRESHOLD) return 90
  const t = (norm - EMPTY_THRESHOLD) / (VERY_HIGH_THRESHOLD - EMPTY_THRESHOLD)
  return Math.round(45 + t * 40)
}

function pickRoundRobinLane(candidateIds) {
  if (candidateIds.length === 0) return null
  const ids = [...candidateIds].sort((a, b) => a - b)
  if (lastServedLaneId == null) return ids[0]
  const idx = ids.findIndex((id) => id === lastServedLaneId)
  if (idx === -1) return ids[0]
  return ids[(idx + 1) % ids.length]
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function hasGoogleMapsConfig() {
  return Boolean(String(GEO_API_KEY || '').trim())
}

function cameraUrlsFromEnv(maxLanes = 9) {
  const raw = String(process.env.VITE_CAMERA_URLS || '').trim()
  if (!raw) return Array(maxLanes).fill('')
  const parts = raw.split(',').map((x) => x.trim())
  while (parts.length < maxLanes) parts.push('')
  return parts.slice(0, maxLanes)
}

function buildDefaultLaneRows() {
  const urls = cameraUrlsFromEnv()
  return Array.from({ length: 9 }).map((_, idx) => {
    const source = urls[idx] || null
    return {
      id: idx + 1,
      name: `Lane ${idx + 1}`,
      source,
      configured: Boolean(source),
      available: false,
      stale: true,
      congestionNorm: source ? 0 : null,
      vehicleCount: 0,
      smoothedVehicleCount: 0,
      avgSpeedKmh: 0,
      observedPeak: 0,
      updatedAt: null,
      error: source ? 'Pseudo-live analyzer is warming up.' : null,
    }
  })
}

function readLiveState() {
  try {
    if (!fs.existsSync(LIVE_STATE_PATH)) return null
    const stat = fs.statSync(LIVE_STATE_PATH)
    if (LIVE_STATE_CACHE.data && LIVE_STATE_CACHE.mtimeMs === stat.mtimeMs) {
      return LIVE_STATE_CACHE.data
    }
    const parsed = JSON.parse(fs.readFileSync(LIVE_STATE_PATH, 'utf8'))
    LIVE_STATE_CACHE.mtimeMs = stat.mtimeMs
    LIVE_STATE_CACHE.data = parsed
    return parsed
  } catch {
    return null
  }
}

function isLiveStateFresh(state) {
  const updatedAtMs = state?.updatedAt ? Date.parse(state.updatedAt) : NaN
  if (!Number.isFinite(updatedAtMs)) return false
  return Date.now() - updatedAtMs <= PSEUDO_LIVE_STALE_MS
}

function getLaneRowsFromLiveState() {
  const state = readLiveState()
  const fresh = isLiveStateFresh(state)
  const defaults = buildDefaultLaneRows()

  return defaults.map((base) => {
    const liveLane = Array.isArray(state?.lanes) ? state.lanes.find((lane) => Number(lane.id) === base.id) : null
    if (!liveLane) return base
    const congestionNorm = Number(liveLane.congestionNorm)
    return {
      ...base,
      source: liveLane.source || base.source,
      configured: Boolean(liveLane.configured ?? base.configured),
      available: Boolean(liveLane.available),
      stale: !fresh,
      congestionNorm: Number.isFinite(congestionNorm) ? Math.max(0, Math.min(1, congestionNorm)) : base.congestionNorm,
      vehicleCount: Number.isFinite(Number(liveLane.vehicleCount)) ? Number(liveLane.vehicleCount) : 0,
      smoothedVehicleCount: Number.isFinite(Number(liveLane.smoothedVehicleCount))
        ? Number(liveLane.smoothedVehicleCount)
        : 0,
      avgSpeedKmh: Number.isFinite(Number(liveLane.avgSpeedKmh)) ? Number(liveLane.avgSpeedKmh) : 0,
      observedPeak: Number.isFinite(Number(liveLane.observedPeak)) ? Number(liveLane.observedPeak) : 0,
      updatedAt: liveLane.updatedAt || state?.updatedAt || null,
      error: liveLane.error || (!fresh && base.configured ? 'Pseudo-live analyzer snapshot is stale.' : null),
    }
  })
}

function chooseNextRoundRobinLane(candidates) {
  const viable = candidates.filter((lane) => typeof lane.congestionNorm === 'number')
  if (viable.length === 0) return null
  const chosenId = pickRoundRobinLane(viable.map((lane) => lane.id))
  return viable.find((lane) => lane.id === chosenId) || viable[0]
}

function detectPythonCommand() {
  const candidates = []
  if (process.env.PYTHON_BIN) {
    candidates.push({
      command: process.env.PYTHON_BIN,
      launchArgs: [],
      checkArgs: ['-c', 'print(1)'],
    })
  }
  if (process.platform === 'win32') {
    candidates.push({
      command: 'py',
      launchArgs: ['-3'],
      checkArgs: ['-3', '-c', 'print(1)'],
    })
  }
  candidates.push(
    { command: 'python3', launchArgs: [], checkArgs: ['-c', 'print(1)'] },
    { command: 'python', launchArgs: [], checkArgs: ['-c', 'print(1)'] },
  )

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.checkArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return candidate
  }
  return null
}

function stopPseudoLiveAnalyzer() {
  if (!pseudoLiveChild || pseudoLiveChild.killed) return
  pseudoLiveChild.kill()
}

function startPseudoLiveAnalyzer() {
  if (!PSEUDO_LIVE_AUTO_START) {
    console.log('Pseudo-live analyzer auto-start disabled by env.')
    return
  }
  const scriptPath = path.join(ROOT_DIR, 'pseudo_live_detection_service.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn(`Pseudo-live analyzer script not found: ${scriptPath}`)
    return
  }
  const python = detectPythonCommand()
  if (!python) {
    console.warn('No Python interpreter found. Pseudo-live analyzer was not started.')
    return
  }

  pseudoLiveChild = spawn(python.command, [...python.launchArgs, scriptPath], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PSEUDO_LIVE_STATE_FILE: LIVE_STATE_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  pseudoLiveChild.stdout.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[pseudo-live] ${text}`)
  })
  pseudoLiveChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.warn(`[pseudo-live] ${text}`)
  })
  pseudoLiveChild.on('exit', (code) => {
    console.warn(`Pseudo-live analyzer exited with code ${code}.`)
    pseudoLiveChild = null
  })
  pseudoLiveChild.on('error', (error) => {
    console.warn(`Failed to start pseudo-live analyzer: ${error.message}`)
    pseudoLiveChild = null
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopPseudoLiveAnalyzer()
    process.exit(0)
  })
}

function closestPlaceByCoords(lat, lon) {
  let best = null
  for (const p of PLACES) {
    const d = haversineKm(lat, lon, p.lat, p.lon)
    if (!best || d < best.distanceKm) best = { ...p, distanceKm: Number(d.toFixed(2)) }
  }
  return best
}

async function fetchJsonWithTimeout(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(GEO_PROVIDER_TIMEOUT_MS),
  })
  const raw = await response.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { raw }
  }
  return { ok: response.ok, status: response.status, data }
}

function googleErrorMessage(data, fallback = 'Google Maps request failed.') {
  if (typeof data?.error?.message === 'string' && data.error.message.trim()) return data.error.message.trim()
  if (typeof data?.error_message === 'string' && data.error_message.trim()) return data.error_message.trim()
  if (typeof data?.status === 'string' && data.status !== 'OK' && data.status.trim()) {
    return `Google Maps returned ${data.status}.`
  }
  return fallback
}

function normalizeCoords(coords) {
  if (!coords) return null
  const lat = Number(coords.lat)
  const lon = Number(coords.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon }
}

function buildLatLngString(coords) {
  return `${coords.lat},${coords.lon}`
}

async function googleGeocodeAddress(address) {
  const query = String(address || '').trim()
  if (!query) return { ok: false, error: 'Address is required.' }
  const url = new URL(GOOGLE_GEOCODE_URL)
  url.searchParams.set('address', query)
  url.searchParams.set('key', GEO_API_KEY)

  const { ok, status, data } = await fetchJsonWithTimeout(url)
  if (!ok) {
    return { ok: false, error: googleErrorMessage(data, `Google geocoding failed with HTTP ${status}.`) }
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
    return { ok: false, error: googleErrorMessage(data, 'Location not found.') }
  }

  const result = data.results[0]
  const location = result?.geometry?.location
  if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) {
    return { ok: false, error: 'Google geocoding did not return coordinates.' }
  }

  return {
    ok: true,
    formattedAddress: result.formatted_address || query,
    coords: { lat: Number(location.lat), lon: Number(location.lng) },
    placeId: result.place_id || null,
  }
}

async function googleReverseGeocode(coords) {
  const point = normalizeCoords(coords)
  if (!point) return { ok: false, error: 'Valid coordinates are required.' }
  const url = new URL(GOOGLE_GEOCODE_URL)
  url.searchParams.set('latlng', buildLatLngString(point))
  url.searchParams.set('key', GEO_API_KEY)

  const { ok, status, data } = await fetchJsonWithTimeout(url)
  if (!ok) {
    return { ok: false, error: googleErrorMessage(data, `Google reverse geocoding failed with HTTP ${status}.`) }
  }
  if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
    return { ok: false, error: googleErrorMessage(data, 'No address found for the selected coordinates.') }
  }

  return {
    ok: true,
    formattedAddress: data.results[0].formatted_address || buildLatLngString(point),
    coords: point,
    placeId: data.results[0].place_id || null,
  }
}

function buildGoogleMapsDirUrl(origin, destination) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=driving`
}

function routeConditionFromDurations(baseDurationSec, trafficDurationSec) {
  if (!Number.isFinite(baseDurationSec) || baseDurationSec <= 0 || !Number.isFinite(trafficDurationSec)) return 'Moderate'
  const ratio = trafficDurationSec / baseDurationSec
  if (ratio >= 1.25) return 'Congested'
  if (ratio >= 1.1) return 'Moderate'
  return 'Smooth'
}

function routeFuelNote(condition, idx) {
  if (idx === 0) return 'Fastest route returned by live map data.'
  if (condition === 'Smooth') return 'Smooth traffic may help reduce idle fuel usage.'
  if (condition === 'Congested') return 'Higher traffic detected; compare with the faster options above.'
  return 'Balanced route with moderate traffic.'
}

function parseGoogleDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return NaN
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)s$/i)
  if (!match) return NaN
  return Number(match[1])
}

function buildGoogleWaypoint(coords, address) {
  const point = normalizeCoords(coords)
  if (point) {
    return {
      location: {
        latLng: {
          latitude: point.lat,
          longitude: point.lon,
        },
      },
    }
  }

  const query = String(address || '').trim()
  if (!query) return null
  return { address: query }
}

async function resolveRouteLabel(address, coords) {
  const point = normalizeCoords(coords)
  const query = String(address || '').trim()
  if (!point) return query
  if (query && !/^current location\b/i.test(query) && query !== buildLatLngString(point)) {
    return query
  }
  const reversed = await googleReverseGeocode(point)
  if (reversed.ok && reversed.formattedAddress) return reversed.formattedAddress
  return buildLatLngString(point)
}

async function googlePlanRoutes({ source, destination, sourceCoords, destinationCoords, maxRoutes = 3 }) {
  const srcCoords = normalizeCoords(sourceCoords)
  const dstCoords = normalizeCoords(destinationCoords)
  const origin = buildGoogleWaypoint(srcCoords, source)
  const destinationValue = buildGoogleWaypoint(dstCoords, destination)
  if (!origin || !destinationValue) return { ok: false, error: 'Source and destination are required.' }
  const [originLabel, destinationLabel] = await Promise.all([
    resolveRouteLabel(source, srcCoords),
    resolveRouteLabel(destination, dstCoords),
  ])

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GEO_API_KEY,
    'X-Goog-FieldMask':
      'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description,routes.polyline.encodedPolyline',
  }
  const body = {
    origin,
    destination: destinationValue,
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: true,
    units: 'METRIC',
    languageCode: 'en-US',
    departureTime: new Date().toISOString(),
  }

  const { ok, status, data } = await fetchJsonWithTimeout(GOOGLE_ROUTES_COMPUTE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!ok) {
    return { ok: false, error: googleErrorMessage(data, `Google Routes API failed with HTTP ${status}.`) }
  }
  if (!Array.isArray(data.routes) || data.routes.length === 0) {
    return { ok: false, error: googleErrorMessage(data, 'No driving routes were found for that request.') }
  }

  const limitedRoutes = data.routes.slice(0, Math.max(1, maxRoutes))
  const resolvedSource = originLabel
  const resolvedDestination = destinationLabel

  const routes = limitedRoutes.map((route, idx) => {
    const trafficSeconds = parseGoogleDurationSeconds(route.duration)
    const baseSeconds = parseGoogleDurationSeconds(route.staticDuration)
    const effectiveTrafficSeconds = Number.isFinite(trafficSeconds) ? trafficSeconds : baseSeconds
    const effectiveBaseSeconds = Number.isFinite(baseSeconds) ? baseSeconds : effectiveTrafficSeconds
    const etaMins = Math.max(1, Math.round(effectiveTrafficSeconds / 60))
    const condition = routeConditionFromDurations(effectiveBaseSeconds, effectiveTrafficSeconds)
    const summary = String(route.description || '').trim()
    const path = summary
      ? `${resolvedSource} -> ${summary} -> ${resolvedDestination}`
      : `${resolvedSource} -> ${resolvedDestination}`
    const mapOrigin = srcCoords ? buildLatLngString(srcCoords) : resolvedSource
    const mapDestination = dstCoords ? buildLatLngString(dstCoords) : resolvedDestination
    return {
      id: String(idx + 1),
      label: idx === 0 ? 'Best live route' : `Alternate route ${idx + 1}`,
      path,
      etaMins,
      condition,
      fuelNote: routeFuelNote(condition, idx),
      mapUrl: buildGoogleMapsDirUrl(mapOrigin, mapDestination),
      mapEmbedUrl: null,
      distanceKm: Number.isFinite(Number(route.distanceMeters))
        ? Number((Number(route.distanceMeters) / 1000).toFixed(1))
        : null,
    }
  })

  return {
    ok: true,
    source: resolvedSource,
    destination: resolvedDestination,
    routes,
    provider: 'google-routes-api',
  }
}

async function googleNearbyParking({ location, coords }) {
  const point = normalizeCoords(coords)
  const resolvedLocation = point
    ? await googleReverseGeocode(point)
    : await googleGeocodeAddress(location)
  if (!resolvedLocation.ok) {
    return { ok: false, error: resolvedLocation.error }
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': GEO_API_KEY,
    'X-Goog-FieldMask':
      'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.primaryTypeDisplayName',
  }

  const body = {
    includedTypes: ['parking'],
    rankPreference: 'DISTANCE',
    maxResultCount: 10,
    locationRestriction: {
      circle: {
        center: {
          latitude: resolvedLocation.coords.lat,
          longitude: resolvedLocation.coords.lon,
        },
        radius: 1000,
      },
    },
  }

  const { ok, status, data } = await fetchJsonWithTimeout(GOOGLE_PLACES_NEARBY_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!ok) {
    return { ok: false, error: googleErrorMessage(data, `Google parking lookup failed with HTTP ${status}.`) }
  }

  const places = Array.isArray(data.places) ? data.places : []
  const zones = places
    .map((place, idx) => {
      const lat = Number(place.location?.latitude)
      const lon = Number(place.location?.longitude)
      const distanceKm =
        Number.isFinite(lat) && Number.isFinite(lon)
          ? Number(haversineKm(resolvedLocation.coords.lat, resolvedLocation.coords.lon, lat, lon).toFixed(2))
          : null
      return {
        id: place.id || String(idx + 1),
        name: place.displayName?.text || place.formattedAddress || `Parking option ${idx + 1}`,
        distanceKm: distanceKm ?? 0,
        slots: 'Unknown',
        availability: place.primaryTypeDisplayName?.text || 'Live place result',
        address: place.formattedAddress || '',
        mapUrl: place.googleMapsUri || null,
      }
    })
    .sort((a, b) => a.distanceKm - b.distanceKm)

  return {
    ok: true,
    location: resolvedLocation.formattedAddress,
    radiusKm: 1,
    center: resolvedLocation.coords,
    zones,
    provider: 'google-places-nearby',
  }
}

async function callGeoProvider(url, payload) {
  if (!url) return null
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (GEO_API_KEY) headers[GEO_API_KEY_HEADER] = `${GEO_API_KEY_PREFIX}${GEO_API_KEY}`
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GEO_PROVIDER_TIMEOUT_MS),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

startPseudoLiveAnalyzer()

const app = express()
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }))
app.use(express.json())

app.post('/api/ai/decision', authMiddleware, (req, res) => {
  const activeLaneIds = Array.isArray(req.body?.activeLaneIds)
    ? req.body.activeLaneIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 9)
    : []
  const lanes = getLaneRowsFromLiveState()
  const state = readLiveState()
  const stateFresh = isLiveStateFresh(state)
  const emergencyLaneCandidate = Number(req.body?.emergencyLane)
  const canForceEmergency = req.user.role === 'admin' || req.user.role === 'traffic_police'
  const emergencyLane =
    canForceEmergency && Number.isInteger(emergencyLaneCandidate) ? emergencyLaneCandidate : null

  const candidates = lanes.filter(
    (lane) => activeLaneIds.includes(lane.id) && lane.available && !lane.stale && typeof lane.congestionNorm === 'number',
  )
  let chosen = chooseNextRoundRobinLane(candidates)

  if (Number.isInteger(emergencyLane) && activeLaneIds.includes(emergencyLane)) {
    const forced = lanes.find(
      (lane) => lane.id === emergencyLane && lane.available && !lane.stale && typeof lane.congestionNorm === 'number',
    )
    if (forced) chosen = forced
  }

  if (!chosen) {
    return res.json({
      mode: 'ai',
      sourceMode: 'pseudo-live',
      analyzerRunning: Boolean(state?.running),
      analyzerUpdatedAt: state?.updatedAt || null,
      greenLaneId: null,
      greenTimeSec: 40,
      reason: stateFresh
        ? 'No active lanes with usable pseudo-live video data are ready yet. waiting for signal'
        : 'Pseudo-live analyzer is warming up, stopped, or stale. waiting for signal',
      thresholds: { empty: EMPTY_THRESHOLD, veryHigh: VERY_HIGH_THRESHOLD },
      lanes,
    })
  }

  const d = chosen.congestionNorm
  const greenTimeSec = Number.isInteger(emergencyLane) && emergencyLane === chosen.id ? 90 : mapDurationFromCongestion(d)
  const level =
    d <= EMPTY_THRESHOLD ? 'empty' : d >= VERY_HIGH_THRESHOLD ? 'very_high' : 'medium'
  const reasonPrefix = Number.isInteger(emergencyLane) && emergencyLane === chosen.id
    ? `Emergency override for Lane ${chosen.id}.`
    : `Round robin selected Lane ${chosen.id}.`
  const reason =
    level === 'very_high'
      ? `${reasonPrefix} Very high congestion (${d.toFixed(2)}) with ${chosen.vehicleCount} vehicles detected, assigning max green time of 90 seconds.`
      : level === 'empty'
        ? `${reasonPrefix} Near empty (${d.toFixed(2)}), assigning minimum green time of 40 seconds.`
        : `${reasonPrefix} Medium congestion (${d.toFixed(2)}) with ${chosen.vehicleCount} vehicles detected, assigning adaptive green time between 45 and 85 seconds.`

  lastServedLaneId = chosen.id
  return res.json({
    mode: 'ai',
    sourceMode: 'pseudo-live',
    analyzerRunning: Boolean(state?.running),
    analyzerUpdatedAt: state?.updatedAt || null,
    greenLaneId: chosen.id,
    greenTimeSec,
    reason,
    thresholds: { empty: EMPTY_THRESHOLD, veryHigh: VERY_HIGH_THRESHOLD },
    lanes,
  })
})

app.get('/api/ai/status', authMiddleware, (req, res) => {
  const state = readLiveState()
  res.json({
    sourceMode: 'pseudo-live',
    analyzerRunning: Boolean(state?.running),
    analyzerUpdatedAt: state?.updatedAt || null,
    stale: !isLiveStateFresh(state),
    lanes: getLaneRowsFromLiveState(),
  })
})

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {}
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' })
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' })
  }
  const em = String(email).toLowerCase().trim()
  const displayName = String(name).trim()
  const hash = bcrypt.hashSync(String(password), 10)
  if (getUserByEmail(em)) {
    return res.status(409).json({ error: 'Email already registered' })
  }

  let role = 'user'
  if (ADMIN_BOOTSTRAP_EMAIL && em === ADMIN_BOOTSTRAP_EMAIL) {
    const admins = Number(scalar(`SELECT COUNT(*) FROM users WHERE role = 'admin'`) ?? 0)
    if (admins >= 1) {
      return res.status(403).json({
        error: 'An administrator already exists for this installation.',
      })
    }
    role = 'admin'
  }

  try {
    db.run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)', [em, hash, displayName, role])
    persist()
    // Load by email — last_insert_rowid() + getUserById() is unreliable with some sql.js builds
    const row = getUserByEmail(em)
    if (!row) {
      console.error('Register: insert succeeded but user row missing for', em)
      return res.status(500).json({ error: 'Registration failed' })
    }
    const safe = {
      id: Number(row.id),
      email: row.email,
      name: row.name,
      role: row.role,
    }
    const token = signToken(safe)
    return res.status(201).json({ token, user: safe })
  } catch (e) {
    console.error('Register error:', e)
    const msg = String(e?.message || e)
    if (msg.includes('UNIQUE') && (msg.includes('idx_only_one_admin') || msg.includes('role'))) {
      return res.status(403).json({ error: 'An administrator account already exists.' })
    }
    return res.status(500).json({ error: 'Registration failed' })
  }
})

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' })
  }
  const user = getUserByEmail(String(email).toLowerCase().trim())
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }
  const safe = {
    id: Number(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
  }
  res.json({ token: signToken(safe), user: safe })
})

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = getUserById(req.user.sub)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ user })
})

app.get('/api/users/me/routes', authMiddleware, (req, res) => {
  const stmt = db.prepare(
    'SELECT id, label, source, destination, eta_mins, created_at FROM saved_routes WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
  )
  stmt.bind([req.user.sub])
  const routes = []
  while (stmt.step()) {
    routes.push(stmt.getAsObject())
  }
  stmt.free()
  res.json({ routes })
})

app.post('/api/users/me/routes', authMiddleware, (req, res) => {
  const { label, source, destination, eta_mins } = req.body || {}
  if (!label || !source || !destination || eta_mins == null) {
    return res.status(400).json({ error: 'label, source, destination, and eta_mins are required' })
  }
  db.run('INSERT INTO saved_routes (user_id, label, source, destination, eta_mins) VALUES (?, ?, ?, ?, ?)', [
    req.user.sub,
    String(label),
    String(source),
    String(destination),
    Number(eta_mins),
  ])
  persist()
  const id = Number(scalar('SELECT last_insert_rowid()'))
  res.status(201).json({ id })
})

app.post('/api/routes/plan', async (req, res) => {
  const { source, destination, sourceCoords, destinationCoords } = req.body || {}
  const s = String(source || '').trim()
  const d = String(destination || '').trim()
  const srcCoords =
    sourceCoords && Number.isFinite(Number(sourceCoords.lat)) && Number.isFinite(Number(sourceCoords.lon))
      ? { lat: Number(sourceCoords.lat), lon: Number(sourceCoords.lon) }
      : null
  const dstCoords =
    destinationCoords && Number.isFinite(Number(destinationCoords.lat)) && Number.isFinite(Number(destinationCoords.lon))
      ? { lat: Number(destinationCoords.lat), lon: Number(destinationCoords.lon) }
      : null
  if ((!s && !srcCoords) || (!d && !dstCoords)) {
    return res.status(400).json({ error: 'Source and destination are required' })
  }
  const payload = {
    source: s,
    destination: d,
    sourceCoords: srcCoords,
    destinationCoords: dstCoords,
    maxRoutes: 3,
  }

  if (isHttpUrl(GEO_ROUTE_API_URL)) {
    const providerResult = await callGeoProvider(GEO_ROUTE_API_URL, payload)
    if (providerResult?.ok && Array.isArray(providerResult.routes)) {
      return res.json(providerResult)
    }
  }

  if (hasGoogleMapsConfig()) {
    const googleResult = await googlePlanRoutes(payload)
    if (googleResult.ok) return res.json(googleResult)
    return res.status(400).json({ error: googleResult.error })
  }

  const resolvedSource = srcCoords ? closestPlaceByCoords(srcCoords.lat, srcCoords.lon)?.names?.[0] || s : s
  const resolvedDest = dstCoords ? closestPlaceByCoords(dstCoords.lat, dstCoords.lon)?.names?.[0] || d : d
  const planned = planRoutes(resolvedSource, resolvedDest, 3)
  if (!planned.ok) {
    return res.status(400).json({
      error: planned.error,
      knownPlaces: planned.knownPlaces,
    })
  }
  const routes = planned.routes.map((r) => ({ ...r, mapUrl: null, mapEmbedUrl: null }))
  return res.json({
    source: planned.source,
    destination: planned.destination,
    routes,
    provider: 'demo-fallback',
  })
})

app.post('/api/parking/nearby', authMiddleware, async (req, res) => {
  const { location, coords } = req.body || {}
  const hasCoords = coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lon))
  if (!location?.trim() && !hasCoords) {
    return res.status(400).json({ error: 'location or coords is required' })
  }
  const payload = {
    location: String(location || '').trim(),
    coords: hasCoords ? { lat: Number(coords.lat), lon: Number(coords.lon) } : null,
  }

  if (isHttpUrl(GEO_PARKING_API_URL)) {
    const providerResult = await callGeoProvider(GEO_PARKING_API_URL, payload)
    if (providerResult?.ok && Array.isArray(providerResult.zones)) {
      return res.json(providerResult)
    }
  }

  if (hasGoogleMapsConfig()) {
    const googleResult = await googleNearbyParking(payload)
    if (googleResult.ok) return res.json(googleResult)
    return res.status(400).json({ error: googleResult.error })
  }

  if (hasCoords) {
    const center = closestPlaceByCoords(Number(coords.lat), Number(coords.lon))
    const zones = PARKING_ZONES.map((z) => ({
      ...z,
      distanceKm: Number(haversineKm(center.lat, center.lon, z.lat, z.lon).toFixed(2)),
    }))
      .filter((z) => z.distanceKm <= 1)
      .sort((a, b) => a.distanceKm - b.distanceKm)
    return res.json({
      ok: true,
      location: center.names[0],
      radiusKm: 1,
      center: { lat: center.lat, lon: center.lon },
      zones,
      provider: 'demo-fallback',
    })
  }
  const result = parkingNearLocation(String(location).trim())
  if (!result.ok) {
    return res.status(400).json({ error: result.error, knownPlaces: result.knownPlaces })
  }
  return res.json({ ...result, provider: 'demo-fallback' })
})

app.get('/api/admin/intersections', authMiddleware, authorityMiddleware, (_req, res) => {
  const stmt = db.prepare('SELECT code AS id, status, congestion, incidents FROM intersections ORDER BY code')
  const intersections = []
  while (stmt.step()) {
    intersections.push(stmt.getAsObject())
  }
  stmt.free()
  res.json({ intersections })
})

app.get('/api/admin/users', authMiddleware, adminMiddleware, (_req, res) => {
  res.json({ users: listUsersSafe() })
})

app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = Number(req.params.id)
  const { role: nextRole } = req.body || {}
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'Invalid user id' })
  }
  if (nextRole !== 'user' && nextRole !== 'traffic_police') {
    return res.status(400).json({ error: 'role must be "user" or "traffic_police"' })
  }
  const target = getUserById(targetId)
  if (!target) {
    return res.status(404).json({ error: 'User not found' })
  }
  if (target.role === 'admin') {
    return res.status(403).json({ error: 'The administrator account cannot be changed from this screen' })
  }
  db.run('UPDATE users SET role = ? WHERE id = ?', [nextRole, targetId])
  persist()
  const updated = getUserById(targetId)
  res.json({
    user: {
      id: Number(updated.id),
      email: updated.email,
      name: updated.name,
      role: updated.role,
    },
  })
})

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = Number(req.params.id)
  if (!Number.isFinite(targetId)) {
    return res.status(400).json({ error: 'Invalid user id' })
  }
  if (targetId === Number(req.user.sub)) {
    return res.status(403).json({ error: 'You cannot delete your own account' })
  }
  const target = getUserById(targetId)
  if (!target) {
    return res.status(404).json({ error: 'User not found' })
  }
  if (target.role === 'admin') {
    return res.status(403).json({ error: 'The administrator account cannot be deleted' })
  }
  db.run('DELETE FROM saved_routes WHERE user_id = ?', [targetId])
  db.run('DELETE FROM users WHERE id = ?', [targetId])
  persist()
  res.status(204).end()
})

app.listen(PORT, () => {
  console.log(`Traffic API listening on http://localhost:${PORT}`)
  if (ADMIN_BOOTSTRAP_EMAIL) {
    console.log(`Administrator bootstrap email: ${ADMIN_BOOTSTRAP_EMAIL}`)
  } else {
    console.log('Administrator bootstrap email not configured. Set ADMIN_BOOTSTRAP_EMAIL in traffic-web/.env if needed.')
  }
})
