import { useTraffic } from '../../context/TrafficContext'

const widthBarColor = (w) =>
  w >= 4.5 ? 'bg-emerald-500' : w >= 3.5 ? 'bg-cyan-500' : w >= 2.5 ? 'bg-amber-500' : 'bg-rose-500'

const MAX_DISPLAY_WIDTH = 6.0

export default function RoadWidthPanel() {
  const { lanes, congestionModel } = useTraffic()
  const configuredLanes = lanes.filter((l) => l.streamUrl)

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 flex flex-col gap-3">
      <h2 className="text-lg font-semibold leading-none">Road Width & Capacity</h2>
      <p className="text-xs text-slate-400">
        Lane width is measured by the AI (IPM camera estimation) when confidence is sufficient,
        otherwise falls back to the configured value from <span className="font-mono text-slate-300">.env</span>.
      </p>

      {/* Congestion model formula */}
      {congestionModel && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-[10px]">
          <span className="font-medium text-slate-300">Formula: </span>
          <span className="font-mono text-cyan-300">{congestionModel.formula}</span>
          <div className="mt-1 text-slate-400">
            Calibration: {congestionModel.vehiclesPerMeterWidth} vehicles / metre width
          </div>
        </div>
      )}

      {configuredLanes.length === 0 && (
        <p className="text-sm text-slate-500">No configured lanes.</p>
      )}

      <div className="space-y-3">
        {configuredLanes.map((lane) => {
          const w = lane.laneWidthM ?? 3.5
          const cap = lane.laneCapacity ?? Math.max(1, w * 2.5)
          const congScore = lane.density ?? 0
          const barPct = Math.min(100, (w / MAX_DISPLAY_WIDTH) * 100)
          const isAI = lane.widthSource === 'ai_ipm'
          const confidence = lane.widthConfidence ?? 0
          const configW = lane.configWidthM ?? w

          return (
            <div key={lane.id} className="rounded-lg border border-slate-700/60 bg-slate-800/30 p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-100">{lane.name}</span>
                <div className="flex items-center gap-1.5">
                  {/* Source badge — shows whether AI or config is active */}
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${
                    isAI
                      ? 'border-emerald-700/40 bg-emerald-900/20 text-emerald-300'
                      : 'border-slate-600 bg-slate-800/60 text-slate-400'
                  }`}>
                    {isAI ? `🤖 AI · conf ${(confidence * 100).toFixed(0)}%` : '⚙️ Config'}
                  </span>
                  <span className="text-xs text-slate-400">
                    {w.toFixed(2)} m · cap ≈ {cap.toFixed(1)}
                  </span>
                </div>
              </div>

              {/* Width bar */}
              <div className="mb-1 flex items-center gap-2">
                <span className="w-14 text-[10px] text-slate-500">Width</span>
                <div className="flex-1 rounded-full bg-slate-800 h-2">
                  <div className={`h-full rounded-full ${widthBarColor(w)}`} style={{ width: `${barPct}%` }} />
                </div>
                <span className="w-12 text-right text-[10px] text-slate-300">{w.toFixed(2)} m</span>
              </div>

              {/* Congestion bar */}
              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] text-slate-500">Congestion</span>
                <div className="flex-1 rounded-full bg-slate-800 h-2">
                  <div className={`h-full rounded-full ${
                    congScore >= 0.75 ? 'bg-rose-500' : congScore >= 0.35 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`} style={{ width: `${Math.min(100, congScore * 100)}%` }} />
                </div>
                <span className="w-12 text-right text-[10px] font-mono text-slate-300">{congScore.toFixed(3)}</span>
              </div>

              {/* Formula result */}
              <div className="mt-1.5 text-[10px] text-slate-500">
                {lane.vehicleCount} ÷ {cap.toFixed(1)} = <span className="text-cyan-400">{congScore.toFixed(3)}</span>
                {isAI && configW !== w && (
                  <span className="ml-2 text-slate-600">
                    (config was {configW.toFixed(1)} m → AI measured {w.toFixed(2)} m)
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Mentor scenario explanation */}
      <div className="rounded-lg border border-slate-700/40 bg-slate-950/40 p-2.5 text-[10px] text-slate-400">
        <p className="mb-1 font-medium text-slate-300">Why width matters (mentor's scenario):</p>
        <p>4 m lane, 8 vehicles: <span className="text-cyan-300">8 ÷ (4×2.5) = 0.80 — HIGH</span></p>
        <p>2 m lane, 5 vehicles: <span className="text-rose-300">5 ÷ (2×2.5) = 1.00 — MAX</span></p>
        <p className="mt-1 text-slate-500">Narrow lane is more congested despite fewer cars.</p>
      </div>
    </section>
  )
}
