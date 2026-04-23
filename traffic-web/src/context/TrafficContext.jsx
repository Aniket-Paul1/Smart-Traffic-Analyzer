/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiJson, useAuth } from './AuthContext'

const TrafficContext = createContext(null)

const densityMeta = (value) => {
  if (value < 0.33) return { label: 'Low', color: 'text-emerald-300', bg: 'bg-emerald-500/20' }
  if (value < 0.66) return { label: 'Medium', color: 'text-amber-300', bg: 'bg-amber-500/20' }
  return { label: 'High', color: 'text-rose-300', bg: 'bg-rose-500/20' }
}

function cameraUrlsFromEnv() {
  const raw = import.meta.env.VITE_CAMERA_URLS
  if (typeof raw !== 'string' || !raw.trim()) return Array(9).fill('')
  const parts = raw.split(',').map((s) => s.trim())
  while (parts.length < 9) parts.push('')
  return parts.slice(0, 9)
}

function labelFromSource(streamUrl, laneId) {
  if (!streamUrl) return 'NULL'
  const clean = streamUrl.split('?')[0]
  const parts = clean.split('/').filter(Boolean)
  return parts[parts.length - 1] || `Lane ${laneId}`
}

function buildInitialLanes() {
  const urls = cameraUrlsFromEnv()
  const firstVideoLane = urls.findIndex((u) => Boolean(u && u.length > 0)) + 1
  return Array.from({ length: 9 }).map((_, i) => {
    const source = urls[i]
    const streamUrl = source && source.length > 0 ? source : null
    return {
      id: i + 1,
      name: `Lane ${i + 1}`,
      density: 0,
      congestion: 0,
      queueLength: 0,
      vehicleCount: 0,
      avgSpeedKmh: 0,
      available: Boolean(streamUrl),
      sourceError: '',
      status: firstVideoLane > 0 && i + 1 === firstVideoLane ? 'GREEN' : 'RED',
      timer: 0,
      videoLabel: labelFromSource(streamUrl, i + 1),
      streamUrl,
    }
  })
}

export function TrafficProvider({ children }) {
  const { user, canAccessAuthority } = useAuth()
  const [lanes, setLanes] = useState(() => buildInitialLanes())
  const [currentGreenLane, setCurrentGreenLane] = useState(() => {
    const first = buildInitialLanes().find((lane) => lane.streamUrl)
    return first?.id ?? null
  })
  const [aiMode, setAiMode] = useState(true)
  const [manualLane, setManualLane] = useState(1)
  const [manualDuration, setManualDuration] = useState(55)
  const [aiReason, setAiReason] = useState('AI decisions are based on pseudo-live congestion from the configured lane videos')
  const [emergencyLane, setEmergencyLane] = useState(null)
  const [alerts, setAlerts] = useState([
    { id: 1, type: 'Heavy Traffic', message: 'Lane 4 is reaching congestion threshold.', level: 'warning' },
  ])
  const [densitySeries, setDensitySeries] = useState([])
  const [predictionSeries, setPredictionSeries] = useState([])
  const [rlTrainingSeries, setRlTrainingSeries] = useState(
    Array.from({ length: 30 }).map((_, i) => ({ episode: i * 10 + 1, reward: -300 + i * 12 })),
  )
  const inFlightRef = useRef(false)
  const lanesRef = useRef(lanes)
  const currentGreenRef = useRef(currentGreenLane)

  const averageWait = useMemo(() => {
    const source = lanes.filter((lane) => Boolean(lane.streamUrl))
    if (source.length === 0) return 0
    return Number(
      (
        source.reduce((acc, lane) => acc + lane.queueLength * (lane.density + 0.3), 0) /
        source.length
      ).toFixed(1),
    )
  }, [lanes])

  const peakLane = useMemo(() => {
    const source = lanes.filter((lane) => Boolean(lane.streamUrl))
    if (source.length === 0) return lanes[0]
    return source.reduce((a, b) => (a.density > b.density ? a : b), source[0])
  }, [lanes])

  const activeLanes = useMemo(() => lanes.filter((lane) => Boolean(lane.streamUrl)), [lanes])

  useEffect(() => {
    lanesRef.current = lanes
  }, [lanes])

  useEffect(() => {
    currentGreenRef.current = currentGreenLane
  }, [currentGreenLane])

  useEffect(() => {
    if (!user) return

    const interval = setInterval(async () => {
      setLanes((prev) =>
        prev.map((lane) => ({
          ...lane,
          timer: lane.status === 'GREEN' ? Math.max(0, lane.timer - 1) : 0,
        })),
      )

      if (inFlightRef.current) return
      const liveLanes = lanesRef.current
      const liveGreen = currentGreenRef.current
      const activeLane = liveLanes.find((lane) => lane.id === liveGreen)
      if (activeLane && activeLane.status === 'GREEN' && activeLane.timer > 0) return

      inFlightRef.current = true
      try {
        const activeLaneIds = liveLanes.filter((lane) => Boolean(lane.streamUrl)).map((lane) => lane.id)
        if (activeLaneIds.length === 0) {
          setAiReason('No lane videos configured. waiting for signal')
          setLanes((prev) =>
            prev.map((lane) => ({
              ...lane,
              available: false,
              sourceError: '',
              status: 'RED',
              timer: 0,
              density: 0,
              congestion: 0,
              queueLength: 0,
              vehicleCount: 0,
              avgSpeedKmh: 0,
            })),
          )
          return
        }

        if (!aiMode) {
          const pick = activeLaneIds.includes(manualLane) ? manualLane : activeLaneIds[0]
          const greenTime = Math.max(40, Math.min(90, Number(manualDuration) || 40))
          setCurrentGreenLane(pick)
          setAiReason(`Manual override for Lane ${pick}`)
          setLanes((prev) =>
            prev.map((lane) => ({
              ...lane,
              status: lane.id === pick ? 'GREEN' : 'RED',
              timer: lane.id === pick ? greenTime : 0,
            })),
          )
          return
        }

        const data = await apiJson('/api/ai/decision', {
          method: 'POST',
          body: JSON.stringify({
            activeLaneIds,
            emergencyLane: canAccessAuthority ? emergencyLane : null,
            currentGreenLane: liveGreen,
          }),
        })

        const selected = Number(data.greenLaneId)
        const greenTime = Math.max(40, Math.min(90, Number(data.greenTimeSec) || 40))
        setCurrentGreenLane(Number.isInteger(selected) ? selected : null)
        setAiReason(String(data.reason || 'AI decision applied'))
        setLanes((prev) =>
          prev.map((lane) => {
            const aiLane = Array.isArray(data.lanes) ? data.lanes.find((row) => Number(row.id) === lane.id) : null
            const densityRaw = aiLane?.congestionNorm
            const density = typeof densityRaw === 'number' ? Math.max(0, Math.min(1, densityRaw)) : 0
            return {
              ...lane,
              available: Boolean(aiLane?.available ?? lane.streamUrl),
              sourceError: aiLane?.error || '',
              density,
              congestion: Math.round(density * 100),
              queueLength: Math.round(density * 30),
              vehicleCount: Number(aiLane?.vehicleCount || 0),
              avgSpeedKmh: Number(aiLane?.avgSpeedKmh || 0),
              status: lane.id === selected ? 'GREEN' : 'RED',
              timer: lane.id === selected ? greenTime : 0,
            }
          }),
        )
      } catch (error) {
        setAiReason(`AI backend unavailable: ${error?.message || 'unknown error'}`)
      } finally {
        inFlightRef.current = false
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [aiMode, manualLane, manualDuration, emergencyLane, user, canAccessAuthority])

  useEffect(() => {
    const stamp = new Date().toLocaleTimeString()
    const point = {
      t: stamp,
      ...Object.fromEntries(lanes.map((lane) => [`lane${lane.id}`, lane.density])),
    }
    setDensitySeries((prev) => [...prev.slice(-19), point])
    setPredictionSeries(
      Array.from({ length: 12 }).map((_, i) => ({
        step: `+${(i + 1) * 5}s`,
        ...Object.fromEntries(
          lanes.map((lane) => [
            `lane${lane.id}`,
            Math.max(0, Math.min(1, lane.density + (lane.status === 'RED' ? 0.02 * (i + 1) : -0.01 * (i + 1)))),
          ]),
        ),
      })),
    )
  }, [lanes])

  const value = {
    lanes,
    activeLanes,
    densityMeta,
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
    densitySeries,
    predictionSeries,
    rlTrainingSeries,
    setRlTrainingSeries,
  }

  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>
}

export const useTraffic = () => {
  const context = useContext(TrafficContext)
  if (!context) throw new Error('useTraffic must be used inside TrafficProvider')
  return context
}
