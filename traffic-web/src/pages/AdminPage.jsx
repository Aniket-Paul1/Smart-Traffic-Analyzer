import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, apiJson } from '../context/AuthContext'

export default function AdminPage() {
  const { user, loading, canAccessAuthority } = useAuth()
  const [rows, setRows] = useState([])
  const [err, setErr] = useState('')

  useEffect(() => {
    if (loading || !user || !canAccessAuthority) return
    let cancelled = false
    ;(async () => {
      try {
        const { intersections } = await apiJson('/api/admin/intersections')
        if (!cancelled) setRows(intersections || [])
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Failed to load intersections')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, loading, canAccessAuthority])

  if (loading) {
    return <p className="text-sm text-slate-400">Checking session…</p>
  }

  if (!user) {
    return (
      <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <p className="text-slate-300">You must be logged in to open the admin dashboard.</p>
        <Link to="/auth" className="inline-block rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950">
          Go to Login
        </Link>
      </div>
    )
  }

  if (!canAccessAuthority) {
    return (
      <div className="space-y-3 rounded-2xl border border-amber-800/40 bg-amber-950/20 p-4">
        <p className="text-amber-200">This area is restricted to traffic police and the administrator.</p>
        <p className="text-sm text-slate-400">Signed in as {user.email} (role: {user.role}).</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-lg font-semibold">Intersections (authority)</h2>
        <p className="text-sm text-slate-400">
          Intersection list is loaded from the SQLite database via the API (not static mock data).
        </p>
      </section>
      {err && <div className="rounded-lg border border-rose-800/50 bg-rose-950/40 p-3 text-sm text-rose-200">{err}</div>}
      <section className="overflow-hidden rounded-2xl border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-slate-300">
            <tr>
              <th className="p-3">Intersection</th>
              <th className="p-3">System Status</th>
              <th className="p-3">Congestion</th>
              <th className="p-3">Incidents</th>
              <th className="p-3">Action</th>
            </tr>
          </thead>
          <tbody className="bg-slate-950/60">
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-800">
                <td className="p-3">{row.id}</td>
                <td className="p-3">{row.status}</td>
                <td className="p-3">{row.congestion}</td>
                <td className="p-3">{row.incidents}</td>
                <td className="p-3">
                  <button
                    type="button"
                    className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-900"
                    onClick={() => alert('Override is a demo action; wire to your signal controller when available.')}
                  >
                    Manual Override
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
