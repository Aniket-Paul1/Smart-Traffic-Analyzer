import { useTraffic } from '../../context/TrafficContext'

export default function AIDecisionPanel() {
  const { lanes, aiMode, setAiMode, aiReason } = useTraffic()
  const active = lanes.find((lane) => lane.status === 'GREEN')

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
      </div>
      <p className="mb-4 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-300">{aiReason}</p>
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
