import { useTraffic } from '../../context/TrafficContext'

const importanceColor = (v) =>
  v >= 0.8 ? 'bg-rose-500' : v >= 0.5 ? 'bg-amber-500' : v >= 0.2 ? 'bg-cyan-500' : 'bg-slate-600'

export default function XAIPanel() {
  const { xaiData } = useTraffic()

  if (!xaiData) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-lg font-semibold">Explainable AI (XAI)</h2>
        <p className="text-sm text-slate-500">Loading decision explanations…</p>
      </section>
    )
  }

  const { model, formula, explanation, topFeatures, laneDetails, lastDecision, safetyTarget } = xaiData

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-1 text-lg font-semibold">Explainable AI (XAI)</h2>
      <p className="mb-3 text-xs text-slate-400">{model}</p>

      {/* Congestion formula */}
      <div className="mb-3 rounded-lg border border-cyan-800/40 bg-cyan-900/10 px-3 py-2 text-xs">
        <p className="mb-1 font-mono text-cyan-300">{formula}</p>
        <p className="text-slate-300">{explanation}</p>
      </div>

      {/* Per-lane breakdown table */}
      {Array.isArray(laneDetails) && laneDetails.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-slate-400">Per-Lane Congestion Breakdown</p>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="border-b border-slate-700 text-slate-500">
                  <th className="pb-1 pr-2 text-left">Lane</th>
                  <th className="pb-1 pr-2 text-right">Width</th>
                  <th className="pb-1 pr-2 text-right">Capacity</th>
                  <th className="pb-1 pr-2 text-right">Vehicles</th>
                  <th className="pb-1 pr-2 text-right">Score</th>
                  <th className="pb-1 text-right">Level</th>
                </tr>
              </thead>
              <tbody>
                {laneDetails.map((d) => (
                  <tr key={d.lane} className="border-b border-slate-800/60">
                    <td className="py-1 pr-2 text-slate-200">{d.name}</td>
                    <td className="py-1 pr-2 text-right text-slate-300">{d.laneWidthM.toFixed(1)} m</td>
                    <td className="py-1 pr-2 text-right text-slate-300">≈ {d.laneCapacity.toFixed(1)}</td>
                    <td className="py-1 pr-2 text-right text-slate-100">{d.vehicleCount}</td>
                    <td className="py-1 pr-2 text-right font-mono font-bold text-cyan-300">
                      {d.congestionNorm.toFixed(3)}
                    </td>
                    <td className={`py-1 text-right font-medium ${
                      d.congestionLevel === 'Very High'
                        ? 'text-rose-300'
                        : d.congestionLevel === 'Medium'
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                    }`}>
                      {d.congestionLevel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Feature importance bars */}
      {Array.isArray(topFeatures) && topFeatures.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-slate-400">Top Decision Drivers</p>
          <div className="space-y-1.5">
            {topFeatures.map((f, i) => (
              <div key={i}>
                <div className="mb-0.5 flex items-center justify-between text-[10px]">
                  <span className="text-slate-300">{f.explanation || f.feature}</span>
                  <span className="font-semibold text-slate-200">{(f.importance * 100).toFixed(0)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800">
                  <div
                    className={`h-full rounded-full ${importanceColor(f.importance)}`}
                    style={{ width: `${Math.min(100, f.importance * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Last decision summary */}
      {lastDecision && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-[10px] text-slate-300">
          <span className="font-medium text-slate-200">Last decision: </span>
          {lastDecision.reason}
        </div>
      )}

      {/* Safety target */}
      {safetyTarget && (
        <div className="rounded-lg border border-emerald-800/40 bg-emerald-900/10 px-3 py-1.5 text-[10px] text-emerald-300">
          🎯 {safetyTarget}
        </div>
      )}
    </section>
  )
}
