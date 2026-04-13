/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const TrafficContext = createContext(null)

const randomRange = (min, max) => Math.random() * (max - min) + min

const densityMeta = (value) => {
  if (value < 0.33) return { label: 'Low', color: 'text-emerald-300', bg: 'bg-emerald-500/20' }
  if (value < 0.66) return { label: 'Medium', color: 'text-amber-300', bg: 'bg-amber-500/20' }
  return { label: 'High', color: 'text-rose-300', bg: 'bg-rose-500/20' }
}

/** Comma-separated list of up to 9 URLs (lane 1 … lane 9). Empty slots use the demo clip. Set `VITE_CAMERA_URLS` in `.env`. */
function cameraUrlsFromEnv() {
  const raw = import.meta.env.VITE_CAMERA_URLS
  if (typeof raw !== 'string' || !raw.trim()) return Array(9).fill('')
  const parts = raw.split(',').map((s) => s.trim())
  while (parts.length < 9) parts.push('')
  return parts.slice(0, 9)
}

function buildInitialLanes() {
  const urls = cameraUrlsFromEnv()
  return Array.from({ length: 9 }).map((_, i) => {
    const u = urls[i]
    const streamUrl = u && u.length > 0 ? u : null
    return {
      id: i + 1,
      name: `Lane ${i + 1}`,
      density: randomRange(0.1, 0.8),
      congestion: randomRange(20, 90),
      queueLength: Math.round(randomRange(3, 28)),
      status: i === 0 ? 'GREEN' : 'RED',
      timer: i === 0 ? 24 : 0,
      videoLabel: streamUrl ? `Live ${i + 1}` : `Sim Feed ${i + 1}`,
      streamUrl,
    }
  })
}

export function TrafficProvider({ children }) {
  const [lanes, setLanes] = useState(() => buildInitialLanes())
  const [simulationRunning, setSimulationRunning] = useState(true)
  const [simulationSpeed, setSimulationSpeed] = useState(1)
  const [currentGreenLane, setCurrentGreenLane] = useState(1)
  const [aiMode, setAiMode] = useState(true)
  const [manualLane, setManualLane] = useState(1)
  const [manualDuration, setManualDuration] = useState(55)
  const [aiReason, setAiReason] = useState('Highest projected density and queue pressure')
  const [emergencyLane, setEmergencyLane] = useState(null)
  const [alerts, setAlerts] = useState([
    { id: 1, type: 'Heavy Traffic', message: 'Lane 4 is reaching congestion threshold.', level: 'warning' },
    { id: 2, type: 'Roadblock', message: 'Minor roadblock detected on Route B.', level: 'critical' },
  ])
  const [modeComparison] = useState({
    fixedAvgWait: 108,
    aiAvgWait: 64,
    fixedThroughput: 74,
    aiThroughput: 112,
  })

  const [densitySeries, setDensitySeries] = useState(
    Array.from({ length: 20 }).map((_, i) => ({
      t: `${i}s`,
      ...Object.fromEntries(Array.from({ length: 9 }).map((_, laneId) => [`lane${laneId + 1}`, randomRange(0.1, 0.9)])),
    })),
  )
  const [predictionSeries, setPredictionSeries] = useState(
    Array.from({ length: 12 }).map((_, i) => ({
      step: `+${(i + 1) * 5}s`,
      ...Object.fromEntries(Array.from({ length: 9 }).map((_, laneId) => [`lane${laneId + 1}`, randomRange(0.2, 0.95)])),
    })),
  )
  const [rlTrainingSeries, setRlTrainingSeries] = useState(
    Array.from({ length: 30 }).map((_, i) => ({ episode: i * 10 + 1, reward: -300 + i * 12 + randomRange(-20, 20) })),
  )

  const averageWait = useMemo(
    () => Number((lanes.reduce((acc, lane) => acc + lane.queueLength * (lane.density + 0.3), 0) / lanes.length).toFixed(1)),
    [lanes],
  )

  const peakLane = useMemo(() => lanes.reduce((a, b) => (a.density > b.density ? a : b), lanes[0]), [lanes])

  useEffect(() => {
    if (!simulationRunning) return

    const interval = setInterval(
      () => {
        setLanes((prev) => {
          const next = prev.map((lane) => {
            const densityNoise = randomRange(-0.08, 0.1)
            const nextDensity = Math.min(1, Math.max(0, lane.density + densityNoise))
            const nextCongestion = Math.min(100, Math.max(0, lane.congestion + randomRange(-8, 10)))
            const nextQueue = Math.max(0, Math.round(lane.queueLength + randomRange(-2, 3)))
            const nextTimer = lane.status === 'GREEN' ? Math.max(0, lane.timer - 1) : 0
            return { ...lane, density: nextDensity, congestion: nextCongestion, queueLength: nextQueue, timer: nextTimer }
          })

          const active = next.find((l) => l.id === currentGreenLane)
          const shouldSwitch = !active || active.timer <= 0

          if (shouldSwitch) {
            let nextGreenLane = currentGreenLane
            let greenTime = 45
            let reason = 'Round robin progression'

            if (emergencyLane) {
              nextGreenLane = emergencyLane
              greenTime = 90
              reason = 'Emergency vehicle priority override'
            } else if (aiMode) {
              const best = next.reduce((a, b) =>
                a.density * 0.65 + a.queueLength * 0.35 > b.density * 0.65 + b.queueLength * 0.35 ? a : b,
              )
              nextGreenLane = best.id
              greenTime = Math.round(40 + best.density * 50)
              reason = `Selected ${best.name}: high density (${best.density.toFixed(2)}) and queue (${best.queueLength})`
            } else {
              nextGreenLane = manualLane
              greenTime = manualDuration
              reason = `Manual override for Lane ${manualLane}`
            }

            setCurrentGreenLane(nextGreenLane)
            setAiReason(reason)
            return next.map((lane) => ({
              ...lane,
              status: lane.id === nextGreenLane ? 'GREEN' : 'RED',
              timer: lane.id === nextGreenLane ? greenTime : 0,
            }))
          }

          return next
        })

        setDensitySeries((prev) => {
          const nextPoint = {
            t: `${Date.now() % 1000}s`,
            ...Object.fromEntries(lanes.map((lane) => [`lane${lane.id}`, lane.density])),
          }
          const sliced = [...prev.slice(-19), nextPoint]
          return sliced
        })

        setPredictionSeries((prev) =>
          prev.map((p, idx) => ({
            ...p,
            ...Object.fromEntries(
              lanes.map((lane) => [
                `lane${lane.id}`,
                Math.min(1, Math.max(0, lane.density + idx * 0.03 + randomRange(-0.09, 0.09))),
              ]),
            ),
          })),
        )
      },
      Math.max(180, 1000 / simulationSpeed),
    )

    return () => clearInterval(interval)
  }, [simulationRunning, simulationSpeed, currentGreenLane, aiMode, manualLane, manualDuration, emergencyLane, lanes])

  const value = {
    lanes,
    densityMeta,
    simulationRunning,
    setSimulationRunning,
    simulationSpeed,
    setSimulationSpeed,
    aiMode,
    setAiMode,
    manualLane,
    setManualLane,
    manualDuration,
    setManualDuration,
    aiReason,
    averageWait,
    peakLane,
    alerts,
    setAlerts,
    emergencyLane,
    setEmergencyLane,
    modeComparison,
    densitySeries,
    predictionSeries,
    rlTrainingSeries,
    setRlTrainingSeries,
    resetSimulation: () => {
      setLanes(buildInitialLanes())
      setCurrentGreenLane(1)
      setEmergencyLane(null)
    },
  }

  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>
}

export const useTraffic = () => {
  const context = useContext(TrafficContext)
  if (!context) throw new Error('useTraffic must be used inside TrafficProvider')
  return context
}
