import { useAuth } from '../context/AuthContext'
import DashboardGrid from '../components/dashboard/DashboardGrid'
import TrafficAnalytics from '../components/dashboard/TrafficAnalytics'
import AIDecisionPanel from '../components/dashboard/AIDecisionPanel'
import ManualControlPanel from '../components/dashboard/ManualControlPanel'
import PredictionPanel from '../components/dashboard/PredictionPanel'
import SimulationControlPanel from '../components/dashboard/SimulationControlPanel'
import AlertsPanel from '../components/dashboard/AlertsPanel'
import NearbySignalPanel from '../components/dashboard/NearbySignalPanel'
import EmergencyPriorityPanel from '../components/dashboard/EmergencyPriorityPanel'
import AdditionalFeaturesPanel from '../components/dashboard/AdditionalFeaturesPanel'
import DemoComparisonPanel from '../components/dashboard/DemoComparisonPanel'
import RLTrainingPanel from '../components/dashboard/RLTrainingPanel'

export default function DashboardPage() {
  const { canAccessAuthority } = useAuth()

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
        Lane timers and signal decisions are driven by pseudo-live object detection on the configured lane videos.
        Only lanes with configured video feeds participate in green-time decisions.
      </p>
      {!canAccessAuthority && (
        <p className="rounded-lg border border-amber-800/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-200/90">
          You are signed in as a <strong className="font-medium text-amber-100">local user</strong>. You can monitor traffic, analytics, and
          predictions. Signal control, simulation, emergency overrides, and RL training are for{' '}
          <strong className="font-medium text-amber-100">traffic police</strong> (assigned by the administrator) or the administrator.
        </p>
      )}
      <DashboardGrid />
      <TrafficAnalytics />
      {canAccessAuthority && (
        <div className="grid gap-4 xl:grid-cols-3">
          <AIDecisionPanel />
          <ManualControlPanel />
          <SimulationControlPanel />
        </div>
      )}
      <PredictionPanel />
      <div className="grid gap-4 xl:grid-cols-3">
        <AlertsPanel />
        <NearbySignalPanel />
        {canAccessAuthority && <EmergencyPriorityPanel />}
      </div>
      <AdditionalFeaturesPanel />
      <DemoComparisonPanel />
      {canAccessAuthority && <RLTrainingPanel />}
    </div>
  )
}
