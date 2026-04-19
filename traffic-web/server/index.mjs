import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import initSqlJs from 'sql.js'
import { haversineKm, PARKING_ZONES, PLACES, parkingNearLocation, planRoutes } from './demoGeo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'traffic.db')
const ROOT_DIR = path.resolve(__dirname, '..', '..')
const LOGS_DIR = path.join(ROOT_DIR, 'logs')
const JWT_SECRET = process.env.JWT_SECRET || 'traffic-dev-secret-change-in-production'
const PORT = Number(process.env.PORT) || 3001
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const GEO_ROUTE_API_URL = process.env.GEO_ROUTE_API_URL || ''
const GEO_PARKING_API_URL = process.env.GEO_PARKING_API_URL || ''
const GEO_API_KEY = process.env.GEO_API_KEY || ''

/** Exact display name on signup creates the single administrator account (only if none exists yet). */
const ADMIN_SIGNUP_NAME = '1*1@admin'

fs.mkdirSync(DATA_DIR, { recursive: true })

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

function parseSimpleCsv(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim())
    const row = {}
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? ''
    })
    return row
  })
}

function inferDensityFromRow(row) {
  if (!row) return 0
  const keys = Object.keys(row)
  const laneKeys = keys.filter((k) => /^density_lane_\d+$/.test(k))
  if (laneKeys.length > 0) {
    const vals = laneKeys
      .map((k) => Number(row[k]))
      .filter((v) => Number.isFinite(v))
    if (vals.length > 0) return Math.max(...vals)
  }
  const legacy = Number(row.density)
  return Number.isFinite(legacy) ? legacy : 0
}

function loadLaneReplays() {
  if (!fs.existsSync(LOGS_DIR)) return []
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('_timeseries.csv'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return files.map((f) => {
    const full = path.join(LOGS_DIR, f)
    const rows = parseSimpleCsv(fs.readFileSync(full, 'utf8'))
    return {
      name: f,
      rows,
      maxDensity: Math.max(1, ...rows.map((r) => inferDensityFromRow(r))),
    }
  })
}

const laneReplays = loadLaneReplays()
const PSEUDO_LIVE_WARMUP_FRAMES = Number(process.env.PSEUDO_LIVE_WARMUP_FRAMES || 120)
const PSEUDO_LIVE_SMOOTH_WINDOW = Number(process.env.PSEUDO_LIVE_SMOOTH_WINDOW || 45)
let replayCursor = Math.max(0, PSEUDO_LIVE_WARMUP_FRAMES)
let lastServedLaneId = null

const EMPTY_THRESHOLD = 0.05
const VERY_HIGH_THRESHOLD = 0.75

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

function laneCongestionAtCursor(replay, cursor) {
  if (!replay || replay.rows.length === 0) return null
  const len = replay.rows.length
  const w = Math.max(1, Math.min(len, PSEUDO_LIVE_SMOOTH_WINDOW))
  let sum = 0
  for (let i = 0; i < w; i += 1) {
    const idx = (cursor - i + len) % len
    const raw = inferDensityFromRow(replay.rows[idx])
    const norm = Math.max(0, Math.min(1, raw / replay.maxDensity))
    sum += norm
  }
  return sum / w
}

function closestPlaceByCoords(lat, lon) {
  let best = null
  for (const p of PLACES) {
    const d = haversineKm(lat, lon, p.lat, p.lon)
    if (!best || d < best.distanceKm) best = { ...p, distanceKm: Number(d.toFixed(2)) }
  }
  return best
}

async function callGeoProvider(url, payload) {
  if (!url) return null
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (GEO_API_KEY) headers.Authorization = `Bearer ${GEO_API_KEY}`
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

const app = express()
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }))
app.use(express.json())

app.post('/api/ai/decision', (req, res) => {
  const activeLaneIds = Array.isArray(req.body?.activeLaneIds)
    ? req.body.activeLaneIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 9)
    : []
  const emergencyLane = Number(req.body?.emergencyLane)

  const lanes = Array.from({ length: 9 }).map((_, idx) => {
    const laneId = idx + 1
    const replay = laneReplays[idx]
    if (!replay || replay.rows.length === 0) {
      return { id: laneId, congestionNorm: null, source: null }
    }
    const congestionNorm = laneCongestionAtCursor(replay, replayCursor)
    return { id: laneId, congestionNorm, source: replay.name }
  })

  const candidates = lanes.filter((lane) => activeLaneIds.includes(lane.id) && lane.congestionNorm != null)
  const rrLaneId = pickRoundRobinLane(candidates.map((c) => c.id))
  let chosen = rrLaneId == null ? null : candidates.find((c) => c.id === rrLaneId) ?? null

  if (Number.isInteger(emergencyLane) && activeLaneIds.includes(emergencyLane)) {
    const forced = lanes.find((l) => l.id === emergencyLane && l.congestionNorm != null)
    if (forced) chosen = forced
  }

  if (!chosen) {
    replayCursor += 1
    return res.json({
      mode: 'ai',
      greenLaneId: null,
      greenTimeSec: 40,
      reason: 'No active lanes with video/log data. waiting for signal',
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
      ? `${reasonPrefix} Very high congestion (${d.toFixed(2)}), assigning max green time`
      : level === 'empty'
        ? `${reasonPrefix} Near empty (${d.toFixed(2)}), assigning minimum green time`
        : `${reasonPrefix} Medium congestion (${d.toFixed(2)}), assigning adaptive green time`

  lastServedLaneId = chosen.id
  replayCursor += 1
  return res.json({
    mode: 'ai',
    greenLaneId: chosen.id,
    greenTimeSec,
    reason,
    thresholds: { empty: EMPTY_THRESHOLD, veryHigh: VERY_HIGH_THRESHOLD },
    lanes,
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
  if (displayName === ADMIN_SIGNUP_NAME) {
    const admins = Number(scalar(`SELECT COUNT(*) FROM users WHERE role = 'admin'`) ?? 0)
    if (admins >= 1) {
      return res.status(403).json({
        error: `An administrator already exists. Use a different display name (only "${ADMIN_SIGNUP_NAME}" creates the admin account, once).`,
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

app.post('/api/routes/plan', (req, res) => {
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
  const providerResultPromise = callGeoProvider(GEO_ROUTE_API_URL, {
    source: s,
    destination: d,
    sourceCoords: srcCoords,
    destinationCoords: dstCoords,
    maxRoutes: 3,
  })
  providerResultPromise.then((providerResult) => {
    if (providerResult?.ok && Array.isArray(providerResult.routes)) {
      return res.json(providerResult)
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
})

app.post('/api/parking/nearby', authMiddleware, (req, res) => {
  const { location, coords } = req.body || {}
  const hasCoords = coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lon))
  if (!location?.trim() && !hasCoords) {
    return res.status(400).json({ error: 'location or coords is required' })
  }
  const payload = {
    location: String(location || '').trim(),
    coords: hasCoords ? { lat: Number(coords.lat), lon: Number(coords.lon) } : null,
  }
  callGeoProvider(GEO_PARKING_API_URL, payload).then((providerResult) => {
    if (providerResult?.ok && Array.isArray(providerResult.zones)) {
      return res.json(providerResult)
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
  console.log(`Single administrator: sign up once with display name exactly "${ADMIN_SIGNUP_NAME}".`)
})
