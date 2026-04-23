import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Camera, MapPinned, Route, ShieldCheck, TrafficCone, Waves } from 'lucide-react'

const sections = [
  {
    title: 'Pseudo-live lane intelligence',
    text: 'Each configured lane video is analyzed continuously so green-time decisions stay tied to real congestion instead of old CSV snapshots.',
  },
  {
    title: 'Fast operator awareness',
    text: 'Alerts, parking lookups, route planning, and signal state all stay in one place so users do not jump between disconnected tools.',
  },
  {
    title: 'Authority-first control',
    text: 'Local users can monitor, while traffic police and the admin keep access to emergency overrides and operational controls.',
  },
]

const corridorItems = [
  {
    icon: Camera,
    title: 'Live lane vision',
    text: 'Lane feeds keep the decision engine aware of current density instead of relying on old replays.',
  },
  {
    icon: TrafficCone,
    title: 'Adaptive signal timing',
    text: 'Available lanes keep rotating, and green time stretches or shrinks based on congestion.',
  },
  {
    icon: Route,
    title: 'Route and parking support',
    text: 'Drivers and operators can open route previews and parking suggestions without leaving the console immediately.',
  },
  {
    icon: ShieldCheck,
    title: 'Authority controls',
    text: 'Emergency priority and restricted controls stay available for authorized users only.',
  },
]

function SignalLamp({ active, color, shadow, label }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`h-12 w-12 rounded-full border border-white/10 transition-all duration-500 ${
          active ? `${color} ${shadow} scale-105` : 'bg-slate-800'
        }`}
      />
      <span className={`text-xs uppercase tracking-[0.18em] ${active ? 'text-white' : 'text-slate-500'}`}>{label}</span>
    </div>
  )
}

function LiveTrafficSignal() {
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    const durations = [3500, 1200, 3000]
    const timer = window.setTimeout(() => {
      setPhase((current) => (current + 1) % durations.length)
    }, durations[phase])
    return () => window.clearTimeout(timer)
  }, [phase])

  return (
    <div className="mx-auto w-full max-w-[13rem] rounded-[2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))] p-4 shadow-2xl shadow-black/40">
      <div className="mb-4 flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.25em] text-cyan-200">
        <Waves className="h-4 w-4" />
        Live Traffic Signal
      </div>
      <div className="rounded-[2rem] border border-white/5 bg-slate-950/90 px-3 py-5">
        <div className="flex flex-col items-center gap-4">
          <SignalLamp active={phase === 0} color="bg-rose-500" shadow="shadow-[0_0_30px_rgba(244,63,94,0.6)]" label="Stop" />
          <SignalLamp active={phase === 1} color="bg-amber-400" shadow="shadow-[0_0_30px_rgba(251,191,36,0.55)]" label="Wait" />
          <SignalLamp active={phase === 2} color="bg-emerald-500" shadow="shadow-[0_0_30px_rgba(16,185,129,0.6)]" label="Go" />
        </div>
      </div>
    </div>
  )
}

export default function LandingPage() {
  return (
    <div className="scroll-smooth">
      <section className="relative overflow-hidden rounded-[2rem] border border-slate-800 bg-[linear-gradient(135deg,rgba(8,47,73,0.95),rgba(2,6,23,0.98)_55%,rgba(17,94,89,0.9))] px-6 py-16 shadow-2xl shadow-cyan-950/30">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.16),transparent_30%)]" />
        <div className="relative grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div>
            <p className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1 text-xs font-medium uppercase tracking-[0.22em] text-cyan-200">
              Smart Traffic Frontline
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight text-white md:text-6xl">
              Adaptive signals, live congestion, and route intelligence.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-200/90 md:text-base">
              This system watches lane feeds, rotates green time through available lanes, supports emergency priority, and helps people navigate traffic and parking with map-aware tools.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/auth"
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
              >
                Login
                <ArrowRight size={16} />
              </Link>
              <Link
                to="/auth"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300/20 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Sign up
                <ArrowRight size={16} />
              </Link>
              <a
                href="#explore"
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-5 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-400/15"
              >
                Explore features
                <ArrowRight size={16} />
              </a>
            </div>
          </div>

          <LiveTrafficSignal />
        </div>
      </section>

      <section id="explore" className="mt-8 grid gap-5 lg:grid-cols-3">
        {sections.map((section) => (
          <article key={section.title} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
            <h2 className="text-xl font-semibold text-slate-100">{section.title}</h2>
            <p className="mt-3 text-sm leading-7 text-slate-400">{section.text}</p>
          </article>
        ))}
      </section>

      <section className="mt-8 rounded-[2rem] border border-slate-800 bg-slate-900/50 p-6 md:p-8">
        <div className="mb-6 flex items-center gap-3">
          <Waves className="h-7 w-7 text-cyan-300" />
          <h2 className="text-2xl font-semibold text-slate-100">Signal corridor walkthrough</h2>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {corridorItems.map((item) => {
            const Icon = item.icon
            return (
              <div
                key={item.title}
                className="flex items-start gap-4 rounded-2xl border border-slate-800 bg-[linear-gradient(90deg,rgba(15,23,42,0.95),rgba(15,118,110,0.08),rgba(15,23,42,0.95))] p-5"
              >
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                  <Icon className="h-6 w-6 text-cyan-300" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-slate-100">{item.title}</h3>
                  <p className="mt-1 text-sm leading-7 text-slate-400">{item.text}</p>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="mt-8 rounded-[2rem] border border-emerald-800/30 bg-[linear-gradient(135deg,rgba(6,78,59,0.28),rgba(2,6,23,0.9))] p-8 text-center">
        <TrafficCone className="mx-auto h-10 w-10 text-emerald-300" />
        <h2 className="mt-4 text-3xl font-semibold text-white">Enter the control console</h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-300">
          Start from the secure login and signup page, then move straight into the operator dashboard for live monitoring, route planning, and signal control.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/auth"
            className="rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
          >
            Go to login / signup
          </Link>
        </div>
      </section>

      <section className="mt-8 h-8" />
    </div>
  )
}
