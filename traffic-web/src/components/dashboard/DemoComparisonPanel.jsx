import { useTraffic } from '../../context/TrafficContext'

export default function DemoComparisonPanel() {
  const { modeComparison } = useTraffic()
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Simulation Mode (Fixed vs AI)</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-rose-700/30 bg-rose-500/10 p-3 text-sm">
          <p className="text-rose-300">Fixed Signal System</p>
          <p>Avg Wait: {modeComparison.fixedAvgWait}s</p>
          <p>Throughput: {modeComparison.fixedThroughput} veh/min</p>
        </div>
        <div className="rounded-xl border border-emerald-700/30 bg-emerald-500/10 p-3 text-sm">
          <p className="text-emerald-300">AI-Based System</p>
          <p>Avg Wait: {modeComparison.aiAvgWait}s</p>
          <p>Throughput: {modeComparison.aiThroughput} veh/min</p>
        </div>
      </div>
    </section>
  )
}
