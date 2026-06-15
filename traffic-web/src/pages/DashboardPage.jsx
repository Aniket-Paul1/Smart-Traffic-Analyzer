import { useAuth } from '../context/AuthContext'
import AIDecisionPanel from '../components/dashboard/AIDecisionPanel'
import AlertsPanel from '../components/dashboard/AlertsPanel'
import DashboardGrid from '../components/dashboard/DashboardGrid'
import EmergencyPriorityPanel from '../components/dashboard/EmergencyPriorityPanel'
import ManualControlPanel from '../components/dashboard/ManualControlPanel'
import NearbySignalPanel from '../components/dashboard/NearbySignalPanel'
import PredictionPanel from '../components/dashboard/PredictionPanel'
import RLTrainingPanel from '../components/dashboard/RLTrainingPanel'
import TrafficAnalytics from '../components/dashboard/TrafficAnalytics'
import SafetyPanel from '../components/dashboard/SafetyPanel'
import XAIPanel from '../components/dashboard/XAIPanel'
import RoadWidthPanel from '../components/dashboard/RoadWidthPanel'

// Shown every time a local user visits /dashboard
function DashboardDenied({ userName, role }) {
  const roleLabel = role === 'traffic_police' ? 'Traffic Police' : 'Local User'
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="w-full max-w-md rounded-2xl border border-rose-700/40 bg-rose-900/10 p-8">
        <div className="mb-3 text-4xl">🚫</div>
        <h2 className="mb-2 text-xl font-semibold text-rose-300">Access Denied</h2>
        <p className="mb-3 text-sm text-slate-300">
          The traffic monitoring dashboard is restricted to Traffic Police and Administrators only.
        </p>
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          Signed in as: <span className="font-semibold text-slate-200">{userName}</span>
          {' · '}
          <span className="font-semibold text-slate-200">{roleLabel}</span>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          If you are a Traffic Police officer, please ask an Administrator to upgrade your account role.
          Until then, you can use the Route Planner, Feedback, and Parking tabs.
        </p>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { user, canAccessAuthority } = useAuth()

  // Always show denial for local users — every time they visit this route
  if (!canAccessAuthority) {
    return <DashboardDenied userName={user?.name || 'User'} role={user?.role} />
  }

  return (
    <div className="space-y-6">

      {/* ── Row 1: Lane grid (full width) ── */}
      <DashboardGrid />

      {/* ── Row 2: AI decisions + Safety + Road Width ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <AIDecisionPanel />
        <SafetyPanel />
        <RoadWidthPanel />
      </div>

      {/* ── Row 3: Analytics ── */}
      <TrafficAnalytics />

      {/* ── Row 4: XAI + Prediction ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <XAIPanel />
        <PredictionPanel />
      </div>

      {/* ── Row 5: Controls — authority only ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ManualControlPanel />
        <EmergencyPriorityPanel />
      </div>

      {/* ── Row 6: RL Training + Alerts ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RLTrainingPanel />
        <AlertsPanel />
      </div>

      {/* ── Row 7: Nearby signal ── */}
      <NearbySignalPanel />

    </div>
  )
}
