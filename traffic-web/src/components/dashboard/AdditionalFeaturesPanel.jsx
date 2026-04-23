import { useState } from 'react'
import { apiJson } from '../../context/AuthContext'

export default function AdditionalFeaturesPanel() {
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

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Additional Features</h2>
      <div>
        <p className="mb-2 text-sm font-medium text-slate-300">Parking near a location</p>
        <p className="mb-2 text-xs text-slate-500">
          Type any searchable address or use your current location. We list parking options within 1 km.
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
            onClick={requestCurrentLocation}
            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-cyan-300"
          >
            Use current location
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? '...' : 'Suggest parking'}
          </button>
        </form>
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
        {hints.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">Try: {hints.slice(0, 10).join(', ')}</p>
        )}
        {resolvedName && zones.length > 0 && (
          <p className="mt-2 text-xs text-slate-400">
            Near <span className="text-slate-200">{resolvedName}</span> {'(<= 1 km):'}
          </p>
        )}
        <div className="mt-2 space-y-2">
          {zones.map((zone) => (
            <div key={zone.id} className="rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs">
              <span className="font-medium text-slate-200">{zone.name}</span>
              <span className="text-slate-400"> | {zone.distanceKm} km | Slots: {zone.slots} | </span>
              <span>{zone.availability}</span>
              {zone.address ? <div className="mt-1 text-slate-500">{zone.address}</div> : null}
              {zone.mapEmbedUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    setPreviewTitle(zone.name || 'Parking preview')
                    setPreviewUrl(zone.mapEmbedUrl)
                  }}
                  className="mt-1 mr-3 inline-block text-cyan-400 underline hover:text-cyan-300"
                >
                  Quick preview
                </button>
              ) : null}
              {zone.mapUrl ? (
                <a
                  href={zone.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-cyan-400 underline hover:text-cyan-300"
                >
                  Open in map
                </a>
              ) : null}
            </div>
          ))}
        </div>
        {previewUrl && (
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-700 bg-slate-950/80">
            <div className="border-b border-slate-800 px-3 py-2 text-xs text-slate-300">
              Fast map preview: <span className="text-slate-100">{previewTitle}</span>
            </div>
            <iframe
              title={previewTitle || 'Parking preview'}
              className="h-64 w-full border-0 bg-slate-900"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={previewUrl}
            />
          </div>
        )}
      </div>
    </section>
  )
}
