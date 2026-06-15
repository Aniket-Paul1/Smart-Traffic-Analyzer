import { useTraffic } from '../../context/TrafficContext'

export default function AIDecisionPanel() {
  const {
    lanes, aiMode, setAiMode, aiReason,
    safetyScore, casualtyRisk, pedConflict, emergencyActive, congestionModel,
  } = useTraffic()
  const active = lanes.find((lane) => lane.status === 'GREEN')

  const scoreColor =
    safetyScore >= 90 ? 'text-emerald-300' :
    safetyScore >= 70 ? 'text-cyan-300' :
    safetyScore >= 50 ? 'text-amber-300' : 'text-rose-300'

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">AI Decision Panel</h2>

      <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-600/10 p-3">
          <p className="text-slate-400">Selected Lane</p>
          <p className="font-semibold text-emerald-300">{active?.name || 'N/A'}</p>
        </div>
        <div className="rounded-lg border border-cyan-700/40 bg-cyan-600/10 p-3">
          <p className="text-slate-400">Allocated Time</p>
          <p className="font-semibold text-cyan-300">{active?.timer ?? 0} sec</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
          <p className="text-slate-400">Safety Score</p>
          <p className={`font-semibold ${scoreColor}`}>{safetyScore}/100</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
          <p className="text-slate-400">Casualty Risk</p>
          <p className={`font-semibold ${scoreColor}`}>{casualtyRisk}</p>
        </div>
      </div>

      {/* Width-aware lane stats for active lane */}
      {active && (
        <div className="mb-3 rounded-lg border border-slate-700/60 bg-slate-800/30 px-3 py-2 text-[10px] text-slate-400">
          <span className="font-medium text-slate-300">{active.name}: </span>
          {active.laneWidthM?.toFixed(1)} m wide · capacity ≈ {active.laneCapacity?.toFixed(1)} vehicles ·
          congestion score <span className="font-mono text-cyan-300">{active.density?.toFixed(3)}</span>
          <span className="ml-1 text-slate-500">
            ({active.vehicleCount} ÷ {active.laneCapacity?.toFixed(1)})
          </span>
        </div>
      )}

      {/* Safety conflict badges */}
      {(pedConflict || emergencyActive) && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {pedConflict && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">
              🚶 Pedestrian conflict detected
            </span>
          )}
          {emergencyActive && (
            <span className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300">
              🚨 Emergency vehicle priority active
            </span>
          )}
        </div>
      )}

      <p className="mb-4 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-300">
        {aiReason}
      </p>

      {/* Congestion model pill */}
      {congestionModel && (
        <div className="mb-3 rounded-lg border border-slate-700/40 bg-slate-950/40 px-3 py-1.5 text-[10px]">
          <span className="text-slate-400">Model: </span>
          <span className="font-mono text-cyan-300">{congestionModel.formula}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          className={`rounded-lg px-3 py-2 text-sm ${aiMode ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
          onClick={() => setAiMode(true)}
        >
          AI Mode (Pseudo-Live)
        </button>
        <button
          className={`rounded-lg px-3 py-2 text-sm ${!aiMode ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
          onClick={() => setAiMode(false)}
        >
          Manual Mode
        </button>
      </div>
    </section>
  )
}
