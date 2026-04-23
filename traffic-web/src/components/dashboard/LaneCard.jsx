import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTraffic } from '../../context/TrafficContext'

function SignalLight({ active, color }) {
  return (
    <div
      className={clsx(
        'h-4 w-4 rounded-full border border-white/20 transition-all',
        active ? color : 'bg-slate-700',
        active && 'animate-pulse shadow-lg',
      )}
    />
  )
}

export default function LaneCard({ lane }) {
  const { densityMeta } = useTraffic()
  const density = densityMeta(lane.density)
  const isGreen = lane.status === 'GREEN'
  const [failedSource, setFailedSource] = useState(null)
  const streamSrc = lane.streamUrl?.trim() ? lane.streamUrl.trim() : null
  const feedFailed = failedSource === streamSrc
  const hasVideo = Boolean(streamSrc)
  const videoRef = useRef(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el || !hasVideo || feedFailed) return

    if (isGreen) {
      const playPromise = el.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {})
      }
    } else {
      el.pause()
    }
  }, [isGreen, hasVideo, feedFailed, streamSrc])

  return (
    <article className="rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-md">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-100">{lane.name}</h3>
        <span className="text-xs text-slate-400">{lane.videoLabel}</span>
      </div>

      <div className="relative mb-3 h-24 overflow-hidden rounded-lg bg-slate-800">
        {hasVideo && !feedFailed && (
          <video
            key={streamSrc}
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover opacity-80"
            src={streamSrc}
            muted
            playsInline
            loop
            preload="metadata"
            onError={() => setFailedSource(streamSrc)}
          />
        )}
        {hasVideo && feedFailed && (
          <div className="absolute inset-0 bg-slate-800">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(34,211,238,0.25),transparent_70%)]" />
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">Feed unavailable (offline?)</div>
          </div>
        )}
        {!hasVideo && (
          <div className="absolute inset-0 bg-slate-800">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(148,163,184,0.18),transparent_70%)]" />
            <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-400">NULL</div>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(34,211,238,0.15),transparent_70%)]" />
        <div className="absolute right-2 top-2 rounded bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-300">
          {hasVideo ? (isGreen ? 'PLAYING' : 'PAUSED') : 'NO VIDEO'}
        </div>
        <div className="absolute bottom-2 left-2 text-xs text-slate-200 drop-shadow-md">
          {!hasVideo ? 'waiting for signal' : isGreen ? 'Vehicle flow active' : 'Queued at signal'}
        </div>
      </div>

      <p className="mb-2 text-[10px] leading-tight text-slate-500">
        {!hasVideo
          ? 'Lane not configured in this intersection.'
          : lane.sourceError
            ? lane.sourceError
            : 'Congestion is computed from pseudo-live object detection on this lane video.'}
      </p>

      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <SignalLight active={isGreen} color="bg-emerald-500 shadow-emerald-500/40" />
          <SignalLight active={!isGreen} color="bg-rose-500 shadow-rose-500/40" />
        </div>
        <span className={clsx('rounded px-2 py-0.5', isGreen ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300')}>
          {lane.status}
        </span>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <span>Countdown</span>
        <span className="font-semibold text-cyan-300">{lane.timer}s</span>
      </div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <span>Vehicles</span>
        <span className="font-semibold text-slate-100">{lane.vehicleCount}</span>
      </div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <span>Avg Speed</span>
        <span className="font-semibold text-slate-100">{lane.avgSpeedKmh.toFixed(1)} km/h</span>
      </div>
      <div className="mb-1 h-2 rounded-full bg-slate-800">
        <div className={clsx('h-full rounded-full', density.bg)} style={{ width: `${Math.min(100, lane.density * 100)}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Density</span>
        <span className={density.color}>
          {density.label} ({lane.density.toFixed(2)})
        </span>
      </div>
    </article>
  )
}
