import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { CarFront, LayoutDashboard, LogOut, MessageSquareWarning, Shield, UserRound, Users } from 'lucide-react'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import DashboardPage from './pages/DashboardPage'
import RoutePlannerPage from './pages/RoutePlannerPage'
import AdminPage from './pages/AdminPage'
import AuthPage from './pages/AuthPage'
import FeedbackPage from './pages/FeedbackPage'
import UsersPage from './pages/UsersPage'

function RootRedirect() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center text-sm text-slate-400">
        Loading…
      </div>
    )
  }
  return <Navigate to={user ? '/dashboard' : '/auth'} replace />
}

function CatchAllRedirect() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center text-sm text-slate-400">
        Loading…
      </div>
    )
  }
  return <Navigate to={user ? '/dashboard' : '/auth'} replace />
}

function App() {
  const location = useLocation()
  const { user, loading, logout, isAdmin, canAccessAuthority } = useAuth()

  const authenticatedNav = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/route-planner', label: 'Route Planner', icon: CarFront },
    { to: '/feedback', label: 'Feedback', icon: MessageSquareWarning },
    ...(canAccessAuthority ? [{ to: '/admin', label: 'Intersections', icon: Shield }] : []),
    ...(isAdmin ? [{ to: '/users', label: 'Users', icon: Users }] : []),
  ]

  const guestNav = [{ to: '/auth', label: 'Login / Sign up', icon: UserRound }]

  const navItems = user ? authenticatedNav : guestNav

  const roleLabel = loading
    ? 'Session…'
    : !user
      ? 'Not signed in'
      : user.role === 'admin'
        ? 'Administrator'
        : user.role === 'traffic_police'
          ? 'Traffic police'
          : 'Local user'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div>
            <h1 className="text-xl font-semibold md:text-2xl">Smart Intelligent Traffic Management System</h1>
            <p className="text-xs text-slate-400 md:text-sm">AI-driven control, prediction, analytics, and simulation</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg border border-cyan-800/40 bg-cyan-900/20 px-3 py-1 text-xs text-cyan-300">
              {user ? `${user.name} · ${roleLabel}` : roleLabel}
            </div>
            {user && (
              <button
                type="button"
                onClick={() => logout()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
              >
                <LogOut size={14} />
                Log out
              </button>
            )}
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-800 bg-slate-900/70">
        <div className="mx-auto flex max-w-7xl flex-wrap gap-2 px-4 py-3">
          {navItems.map((item) => {
            const active = location.pathname === item.to
            const IconComponent = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  active
                    ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                    : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-500'
                }`}
              >
                <IconComponent size={16} />
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/route-planner"
            element={
              <ProtectedRoute>
                <RoutePlannerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedRoute>
                <UsersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/feedback"
            element={
              <ProtectedRoute>
                <FeedbackPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<CatchAllRedirect />} />
        </Routes>
      </main>
      <footer className="border-t border-slate-800 bg-slate-900/60 px-4 py-4 text-center text-xs text-slate-400">
        Smart City Control Console · React + Tailwind + Recharts
      </footer>
    </div>
  )
}

export default App
