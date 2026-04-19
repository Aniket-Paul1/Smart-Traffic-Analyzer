import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTraffic } from '../../context/TrafficContext'

export default function PredictionPanel() {
  const { predictionSeries, activeLanes } = useTraffic()
  const laneKeys = activeLanes.map((lane) => ({ key: `lane${lane.id}`, name: lane.name }))
  const colors = ['#22c55e', '#06b6d4', '#f59e0b', '#ef4444', '#a78bfa', '#38bdf8', '#e879f9', '#f97316', '#84cc16']
  const data = predictionSeries.map((d) => {
    const row = { step: d.step }
    laneKeys.forEach((lane) => {
      row[lane.key] = d[lane.key]
    })
    return row
  })

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Traffic Prediction Module</h2>
      <div className="h-72 rounded-xl border border-slate-700 bg-slate-950/70 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="step" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip />
            {laneKeys.map((lane, i) => (
              <Line key={lane.key} type="monotone" dataKey={lane.key} name={lane.name} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
