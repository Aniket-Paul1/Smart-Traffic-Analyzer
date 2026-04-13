import { useTraffic } from '../../context/TrafficContext'

export default function SimulationControlPanel() {
  const { simulationRunning, setSimulationRunning, resetSimulation, simulationSpeed, setSimulationSpeed } = useTraffic()
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Simulation Control Panel</h2>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSimulationRunning(true)}
          className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-slate-900"
        >
          Start
        </button>
        <button
          onClick={() => setSimulationRunning(false)}
          className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-slate-900"
        >
          Pause
        </button>
        <button onClick={resetSimulation} className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-medium text-white">
          Reset
        </button>
      </div>
      <label className="mt-4 block text-sm">
        Speed: <span className="text-cyan-300">{simulationSpeed.toFixed(1)}x</span>
        <input
          type="range"
          min={0.5}
          max={4}
          step={0.5}
          value={simulationSpeed}
          onChange={(e) => setSimulationSpeed(Number(e.target.value))}
          className="mt-2 w-full"
        />
      </label>
      <p className="mt-2 text-xs text-slate-400">Current state: {simulationRunning ? 'Running' : 'Paused'}</p>
    </section>
  )
}
