import { useState } from 'react'
import { apiJson } from '../context/AuthContext'

export default function ParkingPage() {
  const [location, setLocation] = useState('')
  const [coords, setCoords] = useState(null)
  const [zones, setZones] = useState([])
  const [resolvedName, setResolvedName] = useState('')
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [hints, setHints] = useState([])

  async function searchParking(e) {
    e.preventDefault()
    setErr('')
    setHints([])
    if (!location.trim() && !coords) {
      setErr('Enter a location name or use current location.')
      setZones([])
      setResolvedName('')
      setPreviewTitle('')
      setPreviewUrl('')
      return
    }
    setLoading(true)
    try {
      const data = await apiJson('/api/parking/nearby', {
        method: 'POST',
        body: JSON.stringify({ location: location.trim(), coords }),
      })
      setResolvedName(data.location || '')
      const nextZones = data.zones || []
      setZones(nextZones)
      if (nextZones[0]?.mapEmbedUrl) {
        setPreviewTitle(nextZones[0].name || 'Parking preview')
        setPreviewUrl(nextZones[0].mapEmbedUrl)
      } else {
        setPreviewTitle('')
        setPreviewUrl('')
      }
      if (!nextZones.length) {
        setErr(`No parking zones were found within ${data.radiusKm ?? 1} km of that location.`)
      }
    } catch (error) {
      setZones([])
      setResolvedName('')
      setPreviewTitle('')
      setPreviewUrl('')
      setErr(error.message || 'Lookup failed')
      if (error.knownPlaces?.length) setHints(error.knownPlaces)
    } finally {
      setLoading(false)
    }
  }

  function requestCurrentLocation() {
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
      (error) => setErr(error.message || 'Could not fetch your current location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  const availabilityColor = (avail) => {
    if (!avail) return 'text-slate-400'
    const lower = avail.toLowerCase()
    if (lower.includes('full') || lower.includes('closed')) return 'text-rose-300'
    if (lower.includes('limited') || lower.includes('few')) return 'text-amber-300'
    return 'text-emerald-300'
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-lg font-semibold text-slate-100">Parking Availability</h2>
        <p className="mt-1 text-sm text-slate-400">
          Search for nearby parking zones by location name or use your current GPS position.
          Results show availability within 1 km.
        </p>
      </div>

      {/* Search */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <p className="mb-3 text-sm font-medium text-slate-300">Find Parking Near a Location</p>
        <form onSubmit={searchParking} className="flex flex-wrap gap-2">
          <input
            value={location}
            onChange={(e) => {
              setLocation(e.target.value)
              setCoords(null)
            }}
            placeholder="Enter location name or address…"
            className="min-w-[200px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={requestCurrentLocation}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-cyan-300 hover:bg-slate-800"
          >
            📍 Use my location
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {loading ? 'Searching…' : 'Search Parking'}
          </button>
        </form>

        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
        {hints.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            Known locations: {hints.slice(0, 10).join(', ')}
          </p>
        )}
      </section>

      {/* Results */}
      {zones.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          {resolvedName && (
            <p className="mb-3 text-sm text-slate-400">
              Showing parking near <span className="font-medium text-slate-200">{resolvedName}</span>
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {zones.map((zone) => (
              <div
                key={zone.id}
                className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-slate-100 text-sm leading-tight">{zone.name}</span>
                  <span className={`shrink-0 text-xs font-semibold ${availabilityColor(zone.availability)}`}>
                    {zone.availability || 'Unknown'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-400">
                  <span>📏 {zone.distanceKm} km away</span>
                  <span>🅿️ {zone.slots} slots</span>
                </div>
                {zone.address && (
                  <p className="text-[10px] text-slate-500 leading-tight">{zone.address}</p>
                )}
                <div className="flex gap-2 mt-auto pt-1">
                  {zone.mapEmbedUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewTitle(zone.name || 'Parking preview')
                        setPreviewUrl(zone.mapEmbedUrl)
                      }}
                      className="text-xs text-cyan-400 underline hover:text-cyan-300"
                    >
                      Quick preview
                    </button>
                  )}
                  {zone.mapUrl && (
                    <a
                      href={zone.mapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-cyan-400 underline hover:text-cyan-300"
                    >
                      Open in maps ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Map preview */}
      {previewUrl && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
          <div className="border-b border-slate-800 px-4 py-2.5 text-sm text-slate-300 flex items-center justify-between">
            <span>Map Preview: <span className="text-slate-100">{previewTitle}</span></span>
            <button
              type="button"
              onClick={() => { setPreviewUrl(''); setPreviewTitle('') }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Close ✕
            </button>
          </div>
          <iframe
            title={previewTitle || 'Parking preview'}
            className="h-80 w-full border-0 bg-slate-900"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            src={previewUrl}
          />
        </section>
      )}
    </div>
  )
}
