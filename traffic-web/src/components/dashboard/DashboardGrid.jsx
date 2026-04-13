import { useTraffic } from '../../context/TrafficContext'
import LaneCard from './LaneCard'

export default function DashboardGrid() {
  const { lanes } = useTraffic()
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">9-Lane Intersection Grid</h2>
        <span className="text-xs text-slate-400">Real-time AI signal updates</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {lanes.map((lane) => (
          <LaneCard key={lane.id} lane={lane} />
        ))}
      </div>
    </section>
  )
}
