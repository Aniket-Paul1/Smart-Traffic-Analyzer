import { useTraffic } from '../../context/TrafficContext'

const widthBarColor = (w) =>
  w >= 4.5 ? 'bg-emerald-500' : w >= 3.5 ? 'bg-cyan-500' : w >= 2.5 ? 'bg-amber-500' : 'bg-rose-500'

const MAX_DISPLAY_WIDTH = 6.0   // metres — for bar scaling

export default function RoadWidthPanel() {
  const { lanes, congestionModel } = useTraffic()
  const configuredLanes = lanes.filter((l) => l.streamUrl)

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-1 text-lg font-semibold">Road Width & Capacity</h2>
      <p className="mb-3 text-xs text-slate-400">
        Lane width determines throughput capacity. Narrower lanes fill up faster even with fewer vehicles.
      </p>

      {/* Congestion model formula */}
      {congestionModel && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-[10px]">
          <span className="font-medium text-slate-300">Formula: </span>
          <span className="font-mono text-cyan-300">{congestionModel.formula}</span>
          <div className="mt-1 text-slate-400">
            Calibration: {congestionModel.vehiclesPerMeterWidth} vehicles / metre width
            · Default width: {congestionModel.defaultLaneWidthM} m
          </div>
        </div>
      )}

      {configuredLanes.length === 0 && (
        <p className="text-sm text-slate-500">No configured lanes to display.</p>
      )}

      <div className="space-y-3">
        {configuredLanes.map((lane) => {
          const w = lane.laneWidthM ?? 3.5
          const cap = lane.laneCapacity ?? Math.max(1, w * 2.5)
          const congScore = lane.density ?? 0
          const barPct = Math.min(100, (w / MAX_DISPLAY_WIDTH) * 100)

          return (
            <div key={lane.id} className="rounded-lg border border-slate-700/60 bg-slate-800/30 p-2.5">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-100">{lane.name}</span>
                <span className="text-xs text-slate-400">
                  {w.toFixed(1)} m · cap ≈ {cap.toFixed(1)} vehicles
                </span>
              </div>

              {/* Width bar */}
              <div className="mb-1 flex items-center gap-2">
                <span className="w-12 text-[10px] text-slate-500">Width</span>
                <div className="flex-1 rounded-full bg-slate-800 h-2">
                  <div
                    className={`h-full rounded-full ${widthBarColor(w)}`}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
                <span className="w-10 text-right text-[10px] text-slate-300">{w.toFixed(1)} m</span>
              </div>

              {/* Congestion vs capacity */}
              <div className="flex items-center gap-2">
                <span className="w-12 text-[10px] text-slate-500">Congestion</span>
                <div className="flex-1 rounded-full bg-slate-800 h-2">
                  <div
                    className={`h-full rounded-full ${
                      congScore >= 0.75 ? 'bg-rose-500' : congScore >= 0.35 ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(100, congScore * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right text-[10px] font-mono text-slate-300">{congScore.toFixed(2)}</span>
              </div>

              {/* Formula result */}
              <div className="mt-1 text-[10px] text-slate-500">
                {lane.vehicleCount} vehicles ÷ {cap.toFixed(1)} capacity = {congScore.toFixed(3)} score
              </div>
            </div>
          )
        })}
      </div>

      {/* Mentor scenario explanation */}
      <div className="mt-4 rounded-lg border border-slate-700/40 bg-slate-950/40 p-2.5 text-[10px] text-slate-400">
        <p className="mb-1 font-medium text-slate-300">Why width matters:</p>
        <p>A 4 m lane with 8 vehicles: <span className="text-cyan-300">8 ÷ (4×2.5) = 0.80 — HIGH</span></p>
        <p>A 2 m lane with 5 vehicles: <span className="text-rose-300">5 ÷ (2×2.5) = 1.00 — MAX</span></p>
        <p className="mt-1 text-slate-500">The narrow lane is more congested despite having fewer cars.</p>
      </div>
    </section>
  )
}
