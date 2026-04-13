import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTraffic } from '../../context/TrafficContext'

export default function PredictionPanel() {
  const { predictionSeries } = useTraffic()
  const data = predictionSeries.map((d) => ({
    step: d.step,
    lane1: d.lane1,
    lane4: d.lane4,
    lane7: d.lane7,
  }))

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Traffic Prediction Module</h2>
      <div className="h-72 rounded-xl border border-slate-700 bg-slate-950/70 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="step" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip />
            <Line type="monotone" dataKey="lane1" stroke="#22c55e" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="lane4" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="lane7" stroke="#ef4444" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
