/** Demo catalog: place names → coordinates, parking zones, and a small road graph for multi-route planning. */

export const PLACES = [
  {
    id: 'sector12',
    names: ['sector 12', 'sector12'],
    lat: 12.9716,
    lon: 77.5946,
  },
  {
    id: 'tech_park',
    names: ['tech park', 'techpark', 'it park'],
    lat: 12.9352,
    lon: 77.6245,
  },
  {
    id: 'mall',
    names: ['metro mall', 'mall', 'shopping mall'],
    lat: 12.9784,
    lon: 77.6408,
  },
  {
    id: 'central_plaza',
    names: ['central plaza', 'plaza'],
    lat: 12.968,
    lon: 77.595,
  },
  {
    id: 'riverside',
    names: ['riverside', 'river side'],
    lat: 12.95,
    lon: 77.6,
  },
  {
    id: 'metro_hub',
    names: ['metro hub', 'metro station hub'],
    lat: 12.98,
    lon: 77.61,
  },
  {
    id: 'downtown',
    names: ['downtown', 'city center', 'city centre'],
    lat: 12.96,
    lon: 77.58,
  },
  {
    id: 'market_st',
    names: ['market street', 'market'],
    lat: 12.965,
    lon: 77.605,
  },
  {
    id: 'stadium',
    names: ['stadium', 'sports complex'],
    lat: 12.94,
    lon: 77.615,
  },
]

export const PARKING_ZONES = [
  { id: 'p1', name: 'P1 Central Plaza', lat: 12.9682, lon: 77.5952, slots: 12, availability: 'Moderate' },
  { id: 'p2', name: 'P2 Riverside', lat: 12.9505, lon: 77.5995, slots: 4, availability: 'Low' },
  { id: 'p3', name: 'P3 Metro Hub', lat: 12.9798, lon: 77.6102, slots: 23, availability: 'High' },
  { id: 'p4', name: 'P4 Tech Park East', lat: 12.936, lon: 77.625, slots: 18, availability: 'High' },
  { id: 'p5', name: 'P5 Downtown Garage', lat: 12.9605, lon: 77.5805, slots: 30, availability: 'Moderate' },
  { id: 'p6', name: 'P6 Stadium Lot', lat: 12.9395, lon: 77.6148, slots: 55, availability: 'High' },
]

/** Undirected edges: typical drive times (minutes) between adjacent nodes */
const EDGES = [
  ['sector12', 'central_plaza', 4],
  ['sector12', 'downtown', 5],
  ['central_plaza', 'tech_park', 12],
  ['central_plaza', 'metro_hub', 8],
  ['central_plaza', 'market_st', 5],
  ['market_st', 'tech_park', 10],
  ['downtown', 'riverside', 7],
  ['riverside', 'stadium', 6],
  ['stadium', 'tech_park', 5],
  ['metro_hub', 'mall', 6],
  ['tech_park', 'mall', 8],
  ['riverside', 'market_st', 9],
]

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function norm(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

export function resolvePlace(query) {
  const q = norm(query)
  if (!q) return null

  for (const p of PLACES) {
    for (const n of p.names) {
      const nn = norm(n)
      if (q === nn || q.includes(nn) || nn.includes(q)) return p
    }
  }
  return null
}

export function placeById(id) {
  return PLACES.find((p) => p.id === id) || null
}

function buildAdj() {
  const adj = new Map()
  for (const [a, b, mins] of EDGES) {
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a).push({ to: b, mins })
    adj.get(b).push({ to: a, mins })
  }
  return adj
}

const ADJ = buildAdj()

function pathKey(nodeIds) {
  return nodeIds.join('>')
}

/**
 * Enumerate simple paths from start to end, sorted by total minutes; cap count for performance.
 */
function enumeratePaths(startId, endId, maxPaths = 12, maxDepth = 14) {
  const results = []
  const adj = ADJ

  function dfs(node, target, visited, chain, cost) {
    if (node === target) {
      results.push({ ids: [...chain], cost })
      return
    }
    if (chain.length >= maxDepth) return
    const next = adj.get(node)
    if (!next) return
    for (const { to, mins } of next) {
      if (visited.has(to)) continue
      visited.add(to)
      chain.push(to)
      dfs(to, target, visited, chain, cost + mins)
      chain.pop()
      visited.delete(to)
    }
  }

  dfs(startId, endId, new Set([startId]), [startId], 0)
  results.sort((a, b) => a.cost - b.cost)

  const seen = new Set()
  const unique = []
  for (const r of results) {
    const k = pathKey(r.ids)
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(r)
    if (unique.length >= maxPaths) break
  }
  return unique
}

function primaryLabel(place) {
  return place.names[0].replace(/\b\w/g, (c) => c.toUpperCase())
}

function displayNames(ids) {
  return ids.map((id) => {
    const p = placeById(id)
    if (!p) return id
    return primaryLabel(p)
  })
}

function osmDirectionsUrl(placesPath) {
  if (placesPath.length < 2) return null
  const parts = placesPath.map((p) => `${p.lat}%2C${p.lon}`)
  return `https://www.openstreetmap.org/directions?engine=graphhopper_car&route=${parts.join('%3B')}`
}

function osmEmbedBbox(placesPath) {
  if (placesPath.length === 0) return null
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const p of placesPath) {
    minLon = Math.min(minLon, p.lon)
    maxLon = Math.max(maxLon, p.lon)
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
  }
  const pad = 0.012
  return `https://www.openstreetmap.org/export/embed.html?bbox=${minLon - pad}%2C${minLat - pad}%2C${maxLon + pad}%2C${maxLat + pad}&layer=mapnik`
}

function trafficCondition(seed) {
  const x = Math.abs(seed) % 3
  if (x === 0) return 'Smooth'
  if (x === 1) return 'Moderate'
  return 'Congested'
}

export function planRoutes(sourceQuery, destQuery, maxRoutes = 3) {
  const src = resolvePlace(sourceQuery)
  const dst = resolvePlace(destQuery)
  if (!src) {
    return { ok: false, error: 'Unknown source location', knownPlaces: PLACES.map((p) => primaryLabel(p)) }
  }
  if (!dst) {
    return { ok: false, error: 'Unknown destination location', knownPlaces: PLACES.map((p) => primaryLabel(p)) }
  }
  if (src.id === dst.id) {
    return {
      ok: true,
      source: primaryLabel(src),
      destination: primaryLabel(dst),
      routes: [
        {
          id: '1',
          label: 'Same location',
          path: displayNames([src.id]).join(' → '),
          etaMins: 0,
          condition: 'Smooth',
          fuelNote: 'You are already at the destination.',
          mapUrl: null,
          mapEmbedUrl: osmEmbedBbox([src]),
        },
      ],
    }
  }

  const paths = enumeratePaths(src.id, dst.id, 20, 14).slice(0, maxRoutes)
  if (paths.length === 0) {
    return {
      ok: false,
      error: 'No driving route found between these locations in the demo network.',
      knownPlaces: PLACES.map((p) => primaryLabel(p)),
    }
  }

  const routes = paths.map((p, i) => {
    const pts = p.ids.map((id) => placeById(id)).filter(Boolean)
    const names = displayNames(p.ids)
    const jitter = (p.ids.join('').length + i * 7) % 5
    const etaMins = Math.max(1, Math.round(p.cost + jitter - 2))
    const pathStr = names.join(' → ')
    return {
      id: String(i + 1),
      label: `Option ${i + 1}`,
      path: pathStr,
      etaMins,
      condition: trafficCondition(p.cost * 31 + i * 17),
      fuelNote:
        i === 0
          ? 'Shortest time among alternatives shown.'
          : i === 1
            ? 'Alternate path — compare ETA and traffic.'
            : 'Another viable option if the main roads are slow.',
      mapUrl: osmDirectionsUrl(pts),
      mapEmbedUrl: osmEmbedBbox(pts),
    }
  })

  return {
    ok: true,
    source: primaryLabel(src),
    destination: primaryLabel(dst),
    routes,
  }
}

const RADIUS_KM = 1

export function parkingNearLocation(locationQuery) {
  const center = resolvePlace(locationQuery)
  if (!center) {
    return {
      ok: false,
      error: 'Unknown location name',
      knownPlaces: PLACES.map((p) => primaryLabel(p)),
    }
  }

  const withDist = PARKING_ZONES.map((z) => ({
    ...z,
    distanceKm: Number(haversineKm(center.lat, center.lon, z.lat, z.lon).toFixed(2)),
  }))
    .filter((z) => z.distanceKm <= RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)

  return {
    ok: true,
    location: primaryLabel(center),
    radiusKm: RADIUS_KM,
    center: { lat: center.lat, lon: center.lon },
    zones: withDist,
  }
}
