import { useTraffic } from '../../context/TrafficContext'

const levelColor = {
  warning: 'border-amber-600/50 bg-amber-500/10 text-amber-300',
  critical: 'border-rose-600/50 bg-rose-500/10 text-rose-300',
  info: 'border-cyan-600/50 bg-cyan-500/10 text-cyan-300',
}

export default function AlertsPanel() {
  const { alerts } = useTraffic()
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Traffic Alerts</h2>
      <div className="space-y-2">
        {alerts.map((alert) => (
          <article key={alert.id} className={`rounded-lg border p-3 text-sm ${levelColor[alert.level] || levelColor.info}`}>
            <p className="font-medium">{alert.type}</p>
            <p className="text-xs text-slate-200">{alert.message}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
