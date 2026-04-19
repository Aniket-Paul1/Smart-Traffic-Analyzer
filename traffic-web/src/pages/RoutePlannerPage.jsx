import { useState } from 'react'
import { useAuth, apiJson } from '../context/AuthContext'

const conditionStyles = {
  Smooth: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  Moderate: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  Congested: 'text-rose-300 border-rose-500/30 bg-rose-500/10',
}

export default function RoutePlannerPage() {
  const { user } = useAuth()
  const [source, setSource] = useState('Sector 12')
  const [destination, setDestination] = useState('Tech Park')
  const [sourceCoords, setSourceCoords] = useState(null)
  const [destinationCoords, setDestinationCoords] = useState(null)
  const [routes, setRoutes] = useState([])
  const [meta, setMeta] = useState({ source: '', destination: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [knownPlaces, setKnownPlaces] = useState([])
  const [saveMsg, setSaveMsg] = useState('')

  async function findRoutes() {
    setError('')
    setKnownPlaces([])
    setSaveMsg('')
    setLoading(true)
    try {
      const data = await apiJson('/api/routes/plan', {
        skipAuth: true,
        method: 'POST',
        body: JSON.stringify({ source, destination, sourceCoords, destinationCoords }),
      })
      setMeta({ source: data.source || source, destination: data.destination || destination })
      setRoutes(data.routes || [])
    } catch (e) {
      setRoutes([])
      setMeta({ source: '', destination: '' })
      setKnownPlaces(e.knownPlaces || [])
      setError(
        e.message?.includes('Failed to fetch') || e.message?.includes('Network error')
          ? 'Cannot reach the API. Start the server: npm run server (from traffic-web folder).'
          : e.message || 'Could not plan routes',
      )
    } finally {
      setLoading(false)
    }
  }

  function useCurrentLocation(setter, setText, label) {
    setError('')
    if (!navigator.geolocation) {
      setError('Geolocation is not available in this browser.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lon: Number(pos.coords.longitude.toFixed(6)),
        }
        setter(coords)
        setText(`${label} (${coords.lat}, ${coords.lon})`)
      },
      (err) => {
        setError(err.message || 'Could not fetch your current location.')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  async function saveFastest() {
    if (!user || routes.length === 0) return
    const best = routes[0]
    setSaveMsg('')
    try {
      await apiJson('/api/users/me/routes', {
        method: 'POST',
        body: JSON.stringify({
          label: `${meta.source || source} → ${meta.destination || destination}`,
          source: meta.source || source,
          destination: meta.destination || destination,
          eta_mins: best.etaMins,
        }),
      })
      setSaveMsg('Saved fastest route to your account.')
    } catch (e) {
      setSaveMsg(e.message || 'Save failed')
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-lg font-semibold">Smart Route Planner</h2>
        <p className="mb-3 text-sm text-slate-400">
          Enter source and destination, or use your current location. Route planning now supports external geolocation provider APIs.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-xs text-slate-400">
            Source
            <input
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setSourceCoords(null)
              }}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-slate-100"
            />
            <button
              type="button"
              onClick={() => useCurrentLocation(setSourceCoords, setSource, 'Current Location')}
              className="mt-2 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-cyan-300 hover:bg-slate-800"
            >
              Use current location
            </button>
          </label>
          <label className="block text-xs text-slate-400">
            Destination
            <input
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value)
                setDestinationCoords(null)
              }}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-slate-100"
            />
            <button
              type="button"
              onClick={() => useCurrentLocation(setDestinationCoords, setDestination, 'Current Location')}
              className="mt-2 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-cyan-300 hover:bg-slate-800"
            >
              Use current location
            </button>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => findRoutes()}
            disabled={loading}
            className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {loading ? 'Planning…' : 'Find routes (up to 3)'}
          </button>
          {user && routes.length > 0 && (
            <button
              type="button"
              onClick={() => saveFastest()}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              Save fastest route
            </button>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        {knownPlaces.length > 0 && (
          <p className="mt-2 text-xs text-slate-400">
            Example names you can use: {knownPlaces.slice(0, 12).join(', ')}
            {knownPlaces.length > 12 ? '…' : ''}
          </p>
        )}
        {saveMsg && <p className="mt-2 text-sm text-emerald-300">{saveMsg}</p>}
        {!user && <p className="mt-2 text-xs text-slate-500">Log in to save routes to the database.</p>}
      </section>

      <section className="space-y-4">
        {routes.length === 0 && !loading && !error && (
          <p className="text-sm text-slate-400">Enter origin and destination, then find routes.</p>
        )}
        {routes.map((route) => (
          <article
            key={route.id}
            className={`overflow-hidden rounded-xl border text-sm ${conditionStyles[route.condition] || 'border-slate-600 bg-slate-900/50'}`}
          >
            <div className="border-b border-slate-700/50 p-3">
              <p className="font-semibold text-slate-100">{route.label}</p>
              <p className="mt-1 text-slate-200">{route.path}</p>
              <p className="mt-1">Estimated time: ~{route.etaMins} min</p>
              <p>Condition: {route.condition}</p>
              <p className="text-slate-400">{route.fuelNote}</p>
              {route.mapUrl && (
                <a
                  href={route.mapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-cyan-400 underline hover:text-cyan-300"
                >
                  Open route in provider map
                </a>
              )}
            </div>
            {route.mapEmbedUrl && (
              <iframe
                title={`Map preview for ${route.label}`}
                className="h-[220px] w-full border-0 bg-slate-900"
                loading="lazy"
                src={route.mapEmbedUrl}
              />
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
