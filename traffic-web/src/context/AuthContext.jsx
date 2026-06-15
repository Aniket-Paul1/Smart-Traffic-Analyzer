/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const AuthContext = createContext(null)

// ── Session-only storage ────────────────────────────────────────────────────
// We use sessionStorage instead of localStorage so the token is automatically
// cleared when the browser tab/window is closed.  Every new session requires
// the user to enter their password again — no silent re-login.
const TOKEN_KEY = 'traffic_token'
const storage = window.sessionStorage

const BACKEND_HINT =
  'Start the backend in another terminal: cd traffic-web then npm run server (listens on port 3001).'

async function apiJson(path, options = {}) {
  const { skipAuth, ...init } = options
  const headers = { 'Content-Type': 'application/json', ...init.headers }
  if (!skipAuth) {
    const token = storage.getItem(TOKEN_KEY)
    if (token) headers.Authorization = `Bearer ${token}`
  }
  let res
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    const err = new Error(`Network error. ${BACKEND_HINT}`)
    err.status = 0
    throw err
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) {
    const proxyDown = res.status === 502 || res.status === 503 || res.status === 504
    const message = proxyDown
      ? `Backend unreachable (Bad Gateway). ${BACKEND_HINT}`
      : data.error || res.statusText || 'Request failed'
    const err = new Error(message)
    err.status = res.status
    if (Array.isArray(data.knownPlaces)) err.knownPlaces = data.knownPlaces
    throw err
  }
  return data
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const logout = useCallback(() => {
    storage.removeItem(TOKEN_KEY)
    setUser(null)
  }, [])

  const refreshMe = useCallback(async () => {
    // sessionStorage is cleared on tab close, so this will be empty on every
    // fresh browser open — forcing the user to log in with password each time.
    const token = storage.getItem(TOKEN_KEY)
    if (!token) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      const { user: u } = await apiJson('/api/auth/me')
      setUser(u)
    } catch {
      storage.removeItem(TOKEN_KEY)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshMe()
  }, [refreshMe])

  const login = useCallback(async (email, password) => {
    const { token, user: u } = await apiJson('/api/auth/login', {
      skipAuth: true,
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    // Store in sessionStorage — cleared automatically when browser is closed
    storage.setItem(TOKEN_KEY, token)
    setUser(u)
    return u
  }, [])

  const register = useCallback(async (name, email, password) => {
    const { token, user: u } = await apiJson('/api/auth/register', {
      skipAuth: true,
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    storage.setItem(TOKEN_KEY, token)
    setUser(u)
    return u
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      register,
      logout,
      refreshMe,
      // ── Role flags ──────────────────────────────────────────────────────
      // admin         : full access — everything
      // traffic_police: everything except Users management page
      // user (local)  : dashboard (read-only), route planner, feedback, parking only
      isAdmin: user?.role === 'admin',
      isTrafficPolice: user?.role === 'traffic_police',
      isLocalUser: user?.role === 'user',
      /** Can control signals, manage intersections, see safety log */
      canAccessAuthority: user?.role === 'admin' || user?.role === 'traffic_police',
      /** Can manage user roles (admin only) */
      canManageUsers: user?.role === 'admin',
      getToken: () => storage.getItem(TOKEN_KEY),
    }),
    [user, loading, login, register, logout, refreshMe],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export { apiJson }
