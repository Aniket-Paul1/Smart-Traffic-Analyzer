import { useTraffic } from '../../context/TrafficContext'

export default function NearbySignalPanel() {
  const { lanes } = useTraffic()
  const active = lanes.find((lane) => lane.status === 'GREEN')
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Nearby Signal Information</h2>
      <div className="rounded-lg border border-slate-700 bg-slate-950 p-4">
        <p className="text-sm text-slate-300">Closest Signal: {active?.name}</p>
        <p className="mt-2 text-sm">
          Status:{' '}
          <span className={active?.status === 'GREEN' ? 'text-emerald-300' : 'text-rose-300'}>
            {active?.status || 'RED'}
          </span>
        </p>
        <p className="mt-2 text-sm text-cyan-300">Remaining: {active?.timer ?? 0} sec</p>
      </div>
    </section>
  )
}
