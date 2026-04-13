import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useTraffic } from '../../context/TrafficContext'

export default function RLTrainingPanel() {
  const { rlTrainingSeries } = useTraffic()
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">RL Training Visualization</h2>
      <div className="h-64 rounded-xl border border-slate-700 bg-slate-950/70 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rlTrainingSeries}>
            <XAxis dataKey="episode" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip />
            <Line dataKey="reward" type="monotone" stroke="#22d3ee" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
