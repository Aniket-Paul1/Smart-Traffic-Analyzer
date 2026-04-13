import { useTraffic } from '../../context/TrafficContext'

export default function ManualControlPanel() {
  const { manualLane, setManualLane, manualDuration, setManualDuration, lanes, modeComparison } = useTraffic()

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Manual Control Mode</h2>
      <div className="grid gap-3">
        <label className="text-sm text-slate-300">
          Select Lane
          <select
            value={manualLane}
            onChange={(e) => setManualLane(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          >
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-300">
          Green Duration: <span className="text-cyan-300">{manualDuration}s</span>
          <input
            type="range"
            min={40}
            max={90}
            step={1}
            value={manualDuration}
            onChange={(e) => setManualDuration(Number(e.target.value))}
            className="mt-2 w-full"
          />
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
          <p className="text-slate-400">Fixed Signal Avg Wait</p>
          <p className="text-rose-300">{modeComparison.fixedAvgWait}s</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-950 p-3">
          <p className="text-slate-400">AI Avg Wait</p>
          <p className="text-emerald-300">{modeComparison.aiAvgWait}s</p>
        </div>
      </div>
    </section>
  )
}
