import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTraffic } from '../../context/TrafficContext'

const laneColor = (v) => (v < 0.33 ? '#22c55e' : v < 0.66 ? '#f59e0b' : '#ef4444')

export default function TrafficAnalytics() {
  const { densitySeries, activeLanes, averageWait, peakLane } = useTraffic()
  const activeKeys = activeLanes.map((lane) => `lane${lane.id}`)
  const lineData = densitySeries.map((item) => {
    if (activeKeys.length === 0) return { t: item.t, avg: 0 }
    const avg = activeKeys.reduce((acc, key) => acc + Number(item[key] || 0), 0) / activeKeys.length
    return { t: item.t, avg }
  })
  const barData = activeLanes.map((lane) => ({ name: lane.name, congestion: lane.congestion, density: lane.density }))
  const pieData = activeLanes.map((lane) => ({ name: lane.name, value: Number((lane.density * 100).toFixed(1)) }))

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Traffic Analytics</h2>
        <div className="text-xs text-slate-300">
          Avg wait: <span className="text-cyan-300">{averageWait} sec</span> · Peak: <span className="text-rose-300">{peakLane?.name}</span>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-64 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
          <p className="mb-1 text-xs text-slate-400">Density Over Time</p>
          <ResponsiveContainer width="100%" height="92%">
            <LineChart data={lineData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="t" stroke="#94a3b8" />
              <YAxis stroke="#94a3b8" />
              <Tooltip />
              <Line type="monotone" dataKey="avg" stroke="#22d3ee" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="h-64 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
          <p className="mb-1 text-xs text-slate-400">Congestion Per Lane</p>
          <ResponsiveContainer width="100%" height="92%">
            <BarChart data={barData.length > 0 ? barData : [{ name: 'No video lanes', congestion: 0, density: 0 }]}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" stroke="#94a3b8" interval={0} angle={-20} textAnchor="end" height={48} />
              <YAxis stroke="#94a3b8" domain={[0, 100]} />
              <Tooltip />
              <Legend />
              <Bar dataKey="congestion" minPointSize={4}>
                {(barData.length > 0 ? barData : [{ name: 'No video lanes', density: 0 }]).map((entry) => (
                  <Cell key={entry.name} fill={laneColor(entry.density)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="h-64 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
          <p className="mb-1 text-xs text-slate-400">Traffic Distribution</p>
          <ResponsiveContainer width="100%" height="92%">
            <PieChart>
              <Pie data={pieData.length > 0 ? pieData : [{ name: 'No video lanes', value: 100 }]} dataKey="value" nameKey="name" outerRadius={85} label>
                {(pieData.length > 0 ? pieData : [{ name: 'No video lanes', value: 100 }]).map((entry, i) => (
                  <Cell key={entry.name} fill={['#22c55e', '#06b6d4', '#f59e0b', '#ef4444'][i % 4]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  )
}
