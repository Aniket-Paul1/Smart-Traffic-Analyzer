/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const AuthContext = createContext(null)

const TOKEN_KEY = 'traffic_token'

const BACKEND_HINT =
  'Start the backend in another terminal: cd traffic-web then npm run server (listens on port 3001).'

async function apiJson(path, options = {}) {
  const { skipAuth, ...init } = options
  const headers = { 'Content-Type': 'application/json', ...init.headers }
  if (!skipAuth) {
    const token = localStorage.getItem(TOKEN_KEY)
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
    localStorage.removeItem(TOKEN_KEY)
    setUser(null)
  }, [])

  const refreshMe = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      const { user: u } = await apiJson('/api/auth/me')
      setUser(u)
    } catch {
      localStorage.removeItem(TOKEN_KEY)
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
    localStorage.setItem(TOKEN_KEY, token)
    setUser(u)
    return u
  }, [])

  const register = useCallback(async (name, email, password) => {
    const { token, user: u } = await apiJson('/api/auth/register', {
      skipAuth: true,
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    })
    localStorage.setItem(TOKEN_KEY, token)
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
      isAdmin: user?.role === 'admin',
      isTrafficPolice: user?.role === 'traffic_police',
      /** Intersections + dashboard signal controls */
      canAccessAuthority: user?.role === 'admin' || user?.role === 'traffic_police',
      getToken: () => localStorage.getItem(TOKEN_KEY),
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
