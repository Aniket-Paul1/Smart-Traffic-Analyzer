import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { CarFront, Home, LayoutDashboard, LogOut, MessageSquareWarning, ParkingCircle, UserRound, Users } from 'lucide-react'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import DashboardPage from './pages/DashboardPage'
import RoutePlannerPage from './pages/RoutePlannerPage'
import AuthPage from './pages/AuthPage'
import FeedbackPage from './pages/FeedbackPage'
import UsersPage from './pages/UsersPage'
import LandingPage from './pages/LandingPage'
import ParkingPage from './pages/ParkingPage'

function CatchAllRedirect() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center text-sm text-slate-400">
        Loading...
      </div>
    )
  }
  if (!user) return <Navigate to="/" replace />
  // Everyone goes to dashboard — local users will see the denial message there
  return <Navigate to="/dashboard" replace />
}

function App() {
  const location = useLocation()
  const { user, loading, logout, isLocalUser, canManageUsers } = useAuth()

  // ── Navigation items ────────────────────────────────────────────────────
  // Dashboard shown to ALL roles — local users see the denial message inside
  // the page every time they click it (handled in DashboardPage itself).
  // Local user:           Dashboard + Route Planner + Feedback + Parking
  // traffic_police+admin: all above + Traffic Control
  // admin only:           + Users
  const authenticatedNav = [
    { to: '/dashboard',     label: 'Dashboard',      icon: LayoutDashboard },
    { to: '/route-planner', label: 'Route Planner',  icon: CarFront },
    { to: '/feedback',      label: 'Feedback',       icon: MessageSquareWarning },
    { to: '/parking',       label: 'Parking',        icon: ParkingCircle },
    ...(canManageUsers ? [{ to: '/users', label: 'Users', icon: Users }] : []),
  ]

  const guestNav = [
    { to: '/',      label: 'Home',            icon: Home },
    { to: '/auth',  label: 'Login / Sign up', icon: UserRound },
  ]

  const navItems = user ? authenticatedNav : guestNav

  const roleLabel = loading
    ? 'Session...'
    : !user
      ? 'Not signed in'
      : user.role === 'admin'
        ? 'Administrator'
        : user.role === 'traffic_police'
          ? 'Traffic Police'
          : 'Local User'

  const roleBadgeClass = !user
    ? 'border-slate-700 bg-slate-800/40 text-slate-400'
    : user.role === 'admin'
      ? 'border-rose-700/40 bg-rose-900/20 text-rose-300'
      : user.role === 'traffic_police'
        ? 'border-amber-700/40 bg-amber-900/20 text-amber-300'
        : 'border-cyan-800/40 bg-cyan-900/20 text-cyan-300'

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div>
            <h1 className="text-xl font-semibold md:text-2xl">AI Based Traffic Management System</h1>
            <p className="text-xs text-slate-400 md:text-sm">
              AI-driven control, analytics, routing, and emergency response
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className={`rounded-lg border px-3 py-1 text-xs font-medium ${roleBadgeClass}`}>
              {user ? `${user.name} · ${roleLabel}` : roleLabel}
            </div>
            {user && isLocalUser && (
              <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-2 py-1 text-[10px] text-slate-400">
                View-only access
              </div>
            )}
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
          <Route path="/" element={<LandingPage />} />
          <Route path="/auth" element={<AuthPage />} />

          {/* Dashboard — all logged-in users; local users see denial inside the page */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />

          {/* Route Planner — all logged-in users */}
          <Route
            path="/route-planner"
            element={
              <ProtectedRoute>
                <RoutePlannerPage />
              </ProtectedRoute>
            }
          />

          {/* Feedback — all logged-in users */}
          <Route
            path="/feedback"
            element={
              <ProtectedRoute>
                <FeedbackPage />
              </ProtectedRoute>
            }
          />

          {/* Parking — all logged-in users */}
          <Route
            path="/parking"
            element={
              <ProtectedRoute>
                <ParkingPage />
              </ProtectedRoute>
            }
          />

          {/* Users management — admin only */}
          <Route
            path="/users"
            element={
              <ProtectedRoute requireAdmin>
                <UsersPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<CatchAllRedirect />} />
        </Routes>
      </main>

      <footer className="border-t border-slate-800 bg-slate-900/60 px-4 py-4 text-center text-xs text-slate-400">
        Smart City Control Console
      </footer>
    </div>
  )
}

export default App
