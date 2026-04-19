import { useState } from 'react'
import { apiJson } from '../../context/AuthContext'

const fuelRoutes = [
  { name: 'Eco Route A', saving: '18%', eta: '22 min' },
  { name: 'Eco Route B', saving: '12%', eta: '19 min' },
]

export default function AdditionalFeaturesPanel() {
  const [location, setLocation] = useState('')
  const [coords, setCoords] = useState(null)
  const [zones, setZones] = useState([])
  const [resolvedName, setResolvedName] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [hints, setHints] = useState([])

  async function searchParking(e) {
    e.preventDefault()
    setErr('')
    setHints([])
    if (!location.trim()) {
      if (!coords) {
        setErr('Enter a location name or use current location.')
        setZones([])
        setResolvedName('')
        return
      }
    }
    setLoading(true)
    try {
      const data = await apiJson('/api/parking/nearby', {
        method: 'POST',
        body: JSON.stringify({ location: location.trim(), coords }),
      })
      setResolvedName(data.location || '')
      setZones(data.zones || [])
      if (!data.zones?.length) {
        setErr(`No parking zones with free capacity data within ${data.radiusKm ?? 1} km of that location.`)
      }
    } catch (e) {
      setZones([])
      setResolvedName('')
      setErr(e.message || 'Lookup failed')
      if (e.knownPlaces?.length) setHints(e.knownPlaces)
    } finally {
      setLoading(false)
    }
  }

  function useCurrentLocation() {
    setErr('')
    if (!navigator.geolocation) {
      setErr('Geolocation is not available in this browser.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lon: Number(pos.coords.longitude.toFixed(6)),
        }
        setCoords(next)
        setLocation(`Current Location (${next.lat}, ${next.lon})`)
      },
      (err) => setErr(err.message || 'Could not fetch your current location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Additional Features</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-medium text-slate-300">Parking near a location</p>
          <p className="mb-2 text-xs text-slate-500">
            Type a known place name or use your current location. We list parking zones within 1 km.
          </p>
          <form onSubmit={searchParking} className="flex flex-wrap gap-2">
            <input
              value={location}
              onChange={(e) => {
                setLocation(e.target.value)
                setCoords(null)
              }}
              placeholder="Location name"
              className="min-w-[160px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            />
            <button
              type="button"
              onClick={useCurrentLocation}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-cyan-300"
            >
              Use current location
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {loading ? '…' : 'Suggest parking'}
            </button>
          </form>
          {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
          {hints.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">Try: {hints.slice(0, 10).join(', ')}</p>
          )}
          {resolvedName && zones.length > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Near <span className="text-slate-200">{resolvedName}</span> (≤ 1 km):
            </p>
          )}
          <div className="mt-2 space-y-2">
            {zones.map((z) => (
              <div key={z.id} className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs">
                <span className="font-medium text-slate-200">{z.name}</span>
                <span className="text-slate-400"> · {z.distanceKm} km · Slots: {z.slots} · </span>
                <span>{z.availability}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-300">Fuel-Saving Suggestions</p>
          <div className="space-y-2">
            {fuelRoutes.map((r) => (
              <div key={r.name} className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs">
                {r.name} · Save {r.saving} · ETA {r.eta}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
