import { useEffect, useState } from 'react'
import { apiJson } from '../../context/AuthContext'
import { useTraffic } from '../../context/TrafficContext'

const riskColor = {
  Minimal: 'text-emerald-300 border-emerald-700/40 bg-emerald-600/10',
  Low: 'text-cyan-300 border-cyan-700/40 bg-cyan-600/10',
  Moderate: 'text-amber-300 border-amber-700/40 bg-amber-600/10',
  High: 'text-rose-300 border-rose-700/40 bg-rose-600/10',
  Critical: 'text-red-300 border-red-700/40 bg-red-600/10',
}

function ScoreRing({ score }) {
  const r = 24
  const circ = 2 * Math.PI * r
  const filled = circ * (score / 100)
  const color = score >= 90 ? '#22c55e' : score >= 70 ? '#06b6d4' : score >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" className="shrink-0">
      <circle cx="30" cy="30" r={r} fill="none" stroke="#1e293b" strokeWidth="5" />
      <circle
        cx="30" cy="30" r={r} fill="none"
        stroke={color} strokeWidth="5"
        strokeDasharray={`${filled} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 30 30)"
      />
      <text x="30" y="34" textAnchor="middle" fill={color} fontSize="12" fontWeight="bold">{score}</text>
    </svg>
  )
}

export default function SafetyPanel() {
  const { safetyScore, casualtyRisk, lanes } = useTraffic()
  const [log, setLog] = useState([])
  const [avgScore, setAvgScore] = useState(100)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    async function fetchLog() {
      setLoading(true)
      try {
        const data = await apiJson('/api/safety/log')
        if (!alive) return
        setLog(data.recentEvents?.slice(0, 6) || [])
        setAvgScore(data.avgSafetyScore ?? 100)
      } catch {
        // non-critical — safety log is authority-only; silently ignore for regular users
      } finally {
        if (alive) setLoading(false)
      }
    }
    fetchLog()
    const id = setInterval(fetchLog, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const colorClass = riskColor[casualtyRisk] || riskColor.Minimal
  const pedLanes = lanes.filter((l) => (l.pedestrianCount ?? 0) > 0)
  const emergLanes = lanes.filter((l) => l.emergencyDetected)

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 flex flex-col gap-3">
      <h2 className="text-lg font-semibold leading-none">Safety Monitor</h2>

      {/* Score row — compact */}
      <div className="flex items-center gap-3">
        <ScoreRing score={safetyScore} />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${colorClass}`}>
            Estimated Casualty Risk: <span className="font-bold">{casualtyRisk}</span>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-xs text-slate-300">
            Rolling avg safety score: <span className="font-bold text-cyan-300">{avgScore}/100</span>
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">
            Target: Zero casualties. Score 100 = fully safe. Pedestrian &amp; emergency overrides are automatic.
          </p>
        </div>
      </div>

      {/* Live conflict alerts — only shown when active */}
      {pedLanes.length > 0 && (
        <div className="rounded-lg border border-amber-600/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-300">
          ⚠️ Pedestrians detected in {pedLanes.map((l) => l.name).join(', ')} — oncoming drivers alerted to yield.
        </div>
      )}
      {emergLanes.length > 0 && (
        <div className="rounded-lg border border-rose-600/40 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-300">
          🚨 Emergency vehicle in {emergLanes.map((l) => l.name).join(', ')} — priority green assigned automatically.
        </div>
      )}

      {/* Recent safety log */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-slate-400">Recent Safety Events</p>
        {loading && log.length === 0 && <p className="text-xs text-slate-500">Loading…</p>}
        {!loading && log.length === 0 && (
          <p className="text-xs text-slate-500">No safety events recorded yet.</p>
        )}
        {log.map((entry, i) => (
          <div
            key={i}
            className={`rounded-lg border px-2.5 py-1.5 text-[10px] leading-snug ${
              entry.safetyScore >= 90
                ? 'border-emerald-800/40 bg-emerald-900/20 text-emerald-300'
                : entry.safetyScore >= 60
                  ? 'border-amber-800/40 bg-amber-900/20 text-amber-300'
                  : 'border-rose-800/40 bg-rose-900/20 text-rose-300'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium">Lane {entry.laneId} · score {entry.safetyScore}</span>
              <span className="text-slate-400 shrink-0">{entry.timestamp?.slice(11, 19)}</span>
            </div>
            <div className="mt-0.5 text-slate-300 line-clamp-2">{entry.reason}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
