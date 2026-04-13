import { useTraffic } from '../../context/TrafficContext'

export default function EmergencyPriorityPanel() {
  const { emergencyLane, setEmergencyLane, lanes } = useTraffic()

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Emergency Vehicle Priority</h2>
      {emergencyLane ? (
        <p className="mb-3 rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-sm text-rose-300">
          Emergency vehicle detected at{' '}
          {lanes.find((l) => l.id === emergencyLane)?.name ?? `Lane ${emergencyLane}`}. Priority active.
        </p>
      ) : (
        <p className="mb-3 text-sm text-slate-400">No emergency signals currently detected.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {lanes.map((lane) => (
          <button
            key={lane.id}
            onClick={() => setEmergencyLane(lane.id)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs hover:border-rose-500"
          >
            Trigger {lane.name}
          </button>
        ))}
        <button onClick={() => setEmergencyLane(null)} className="rounded-lg bg-slate-700 px-3 py-2 text-xs">
          Clear
        </button>
      </div>
    </section>
  )
}
