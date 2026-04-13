import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import initSqlJs from 'sql.js'
import { parkingNearLocation, planRoutes } from './demoGeo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH = path.join(DATA_DIR, 'traffic.db')
const JWT_SECRET = process.env.JWT_SECRET || 'traffic-dev-secret-change-in-production'
const PORT = Number(process.env.PORT) || 3001
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

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

const app = express()
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }))
app.use(express.json())

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
  const { source, destination } = req.body || {}
  if (!source?.trim() || !destination?.trim()) {
    return res.status(400).json({ error: 'Source and destination are required' })
  }
  const s = source.trim()
  const d = destination.trim()
  const planned = planRoutes(s, d, 3)
  if (!planned.ok) {
    return res.status(400).json({
      error: planned.error,
      knownPlaces: planned.knownPlaces,
    })
  }
  res.json({
    source: planned.source,
    destination: planned.destination,
    routes: planned.routes,
  })
})

app.post('/api/parking/nearby', authMiddleware, (req, res) => {
  const { location } = req.body || {}
  if (!location?.trim()) {
    return res.status(400).json({ error: 'location is required' })
  }
  const result = parkingNearLocation(location.trim())
  if (!result.ok) {
    return res.status(400).json({ error: result.error, knownPlaces: result.knownPlaces })
  }
  res.json(result)
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
