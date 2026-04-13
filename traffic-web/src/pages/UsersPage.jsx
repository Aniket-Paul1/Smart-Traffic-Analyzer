import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, apiJson } from '../context/AuthContext'

const ROLE_LABEL = {
  admin: 'Administrator',
  traffic_police: 'Traffic police',
  user: 'Local user',
}

export default function UsersPage() {
  const { user, loading, isAdmin } = useAuth()
  const [users, setUsers] = useState([])
  const [err, setErr] = useState('')
  const [updatingId, setUpdatingId] = useState(null)

  const load = useCallback(async () => {
    setErr('')
    try {
      const { users: list } = await apiJson('/api/admin/users')
      setUsers(list || [])
    } catch (e) {
      setErr(e.message || 'Failed to load users')
    }
  }, [])

  useEffect(() => {
    if (loading || !user || !isAdmin) return
    load()
  }, [user, loading, isAdmin, load])

  async function setRole(targetId, nextRole) {
    setUpdatingId(targetId)
    setErr('')
    try {
      await apiJson(`/api/admin/users/${targetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      })
      await load()
    } catch (e) {
      setErr(e.message || 'Update failed')
    } finally {
      setUpdatingId(null)
    }
  }

  async function deleteUser(targetId, email) {
    if (
      !window.confirm(
        `Delete user ${email}? This cannot be undone. Their saved routes will be removed.`,
      )
    ) {
      return
    }
    setUpdatingId(targetId)
    setErr('')
    try {
      await apiJson(`/api/admin/users/${targetId}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setErr(e.message || 'Delete failed')
    } finally {
      setUpdatingId(null)
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-400">Checking session…</p>
  }

  if (!user) {
    return (
      <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <p className="text-slate-300">You must be logged in.</p>
        <Link to="/auth" className="inline-block rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950">
          Go to Login
        </Link>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="space-y-3 rounded-2xl border border-amber-800/40 bg-amber-950/20 p-4">
        <p className="text-amber-200">Only the administrator can view all users.</p>
        <p className="text-sm text-slate-400">Signed in as {user.email} (role: {user.role}).</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="text-lg font-semibold">Users</h2>
        <p className="mt-2 text-sm text-slate-400">
          All accounts (no passwords shown). Assign <span className="text-slate-300">Traffic police</span> for signal and simulation
          controls; <span className="text-slate-300">Local user</span> for public monitoring only. There is only one administrator.
        </p>
      </section>
      {err && <div className="rounded-lg border border-rose-800/50 bg-rose-950/40 p-3 text-sm text-rose-200">{err}</div>}
      <section className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-slate-900 text-slate-300">
            <tr>
              <th className="p-3">ID</th>
              <th className="p-3">Email</th>
              <th className="p-3">Display name</th>
              <th className="p-3">Role</th>
              <th className="p-3">Created</th>
              <th className="p-3 w-[220px]">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-slate-950/60">
            {users.map((u) => {
              const isAdminRow = u.role === 'admin'
              const busy = updatingId === u.id
              return (
                <tr key={u.id} className="border-t border-slate-800">
                  <td className="p-3 font-mono text-xs text-slate-400">{u.id}</td>
                  <td className="p-3">{u.email}</td>
                  <td className="p-3">{u.name}</td>
                  <td className="p-3">{ROLE_LABEL[u.role] || u.role}</td>
                  <td className="p-3 text-xs text-slate-400">{u.created_at || '—'}</td>
                  <td className="p-3">
                    {isAdminRow ? (
                      <span className="text-xs text-slate-500">—</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => setRole(u.id, e.target.value)}
                          className="rounded-lg border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
                        >
                          <option value="user">Local user</option>
                          <option value="traffic_police">Traffic police</option>
                        </select>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => deleteUser(u.id, u.email)}
                          className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-2 py-1 text-xs text-rose-200 hover:bg-rose-950/50 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {users.length === 0 && !err && <p className="p-4 text-sm text-slate-500">No users yet.</p>}
      </section>
    </div>
  )
}
