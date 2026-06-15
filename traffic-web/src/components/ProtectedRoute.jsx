import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

/**
 * ProtectedRoute — role-based access control
 *
 * Role access matrix
 * ------------------
 * Route            | user (local) | traffic_police | admin
 * -----------------|--------------|----------------|------
 * /dashboard       |   ✓ view     |      ✓         |  ✓
 * /feedback        |   ✓          |      ✓         |  ✓
 * /route-planner   |   ✓          |      ✓         |  ✓
 * /parking         |   ✓          |      ✓         |  ✓
 * /admin           |   ✗ denied   |      ✓         |  ✓
 * /users           |   ✗ denied   |   ✗ denied     |  ✓
 *
 * Props
 * -----
 * requireAuthority  — traffic_police or admin only
 * requireAdmin      — admin only
 */
export default function ProtectedRoute({ children, requireAuthority = false, requireAdmin = false }) {
  const { user, loading, canAccessAuthority, canManageUsers } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-400">
        Checking your session…
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />
  }

  // Admin-only page — show denial message to everyone else
  if (requireAdmin && !canManageUsers) {
    return <AccessDenied message="This page is restricted to Administrators only." role={user.role} />
  }

  // Authority page — show denial message to local users
  if (requireAuthority && !canAccessAuthority) {
    return (
      <AccessDenied
        message="You cannot access this page as a Local User. Please ask an Administrator to upgrade your role to Traffic Police."
        role={user.role}
        showUpgradeHint
      />
    )
  }

  return children
}

function AccessDenied({ message, role, showUpgradeHint = false }) {
  const roleLabel =
    role === 'admin' ? 'Administrator' : role === 'traffic_police' ? 'Traffic Police' : 'Local User'

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center px-4">
      <div className="rounded-2xl border border-rose-700/40 bg-rose-900/10 p-8 max-w-md w-full">
        <div className="mb-3 text-4xl">🚫</div>
        <h2 className="mb-2 text-xl font-semibold text-rose-300">Access Denied</h2>
        <p className="mb-3 text-sm text-slate-300">{message}</p>
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          Your current role: <span className="font-semibold text-slate-200">{roleLabel}</span>
        </div>
        {showUpgradeHint && (
          <p className="mt-3 text-xs text-slate-500">
            Traffic Police accounts start as Local Users and must be approved by an Admin before
            gaining access to signal controls and monitoring tools.
          </p>
        )}
      </div>
    </div>
  )
}
