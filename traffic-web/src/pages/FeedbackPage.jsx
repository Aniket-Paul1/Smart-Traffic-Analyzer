import { useEffect, useState } from 'react'
import { apiJson, useAuth } from '../context/AuthContext'

const CATEGORIES = ['Traffic Issue', 'Accident', 'Roadblock', 'Signal Malfunction', 'Other']

const statusBadge = {
  open:    'border-amber-700/40 bg-amber-900/20 text-amber-300',
  replied: 'border-emerald-700/40 bg-emerald-900/20 text-emerald-300',
  closed:  'border-slate-700 bg-slate-800/40 text-slate-400',
}

// ── Submit form (local user + traffic_police) ─────────────────────────────
function SubmitForm({ onSubmitted }) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0])
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setErr('')
    setSuccess('')
    if (!title.trim() || !message.trim()) {
      setErr('Please fill in the title and message.')
      return
    }
    setLoading(true)
    try {
      await apiJson('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ title, category, message }),
      })
      setSuccess('Your feedback has been submitted. An administrator will review it shortly.')
      setTitle('')
      setCategory(CATEGORIES[0])
      setMessage('')
      onSubmitted?.()
    } catch (e) {
      setErr(e.message || 'Submission failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-1 text-lg font-semibold">Submit Feedback</h2>
      <p className="mb-4 text-sm text-slate-400">
        Report traffic issues, accidents, or road conditions directly to authorities.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Title (e.g., Accident near Sector 9)"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
        />
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
        >
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <textarea
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={4}
          placeholder="Describe the issue in detail…"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none resize-none"
        />
        {err && <p className="text-xs text-rose-300">{err}</p>}
        {success && <p className="text-xs text-emerald-300">{success}</p>}
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-cyan-600 px-5 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50 transition"
        >
          {loading ? 'Submitting…' : 'Submit Feedback'}
        </button>
      </form>
    </section>
  )
}

// ── My submitted feedback (local user + traffic_police) ───────────────────
function MyFeedback({ refresh }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      try {
        const data = await apiJson('/api/feedback')
        if (alive) setItems(data.feedback || [])
      } catch {
        // silent
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [refresh])

  if (loading) return <p className="text-sm text-slate-500">Loading your submissions…</p>
  if (!items.length) return <p className="text-sm text-slate-500">You have not submitted any feedback yet.</p>

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">My Submissions</h2>
      <div className="space-y-3">
        {items.map(item => (
          <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
            <div className="mb-1 flex items-start justify-between gap-2">
              <span className="font-medium text-slate-100 text-sm">{item.title}</span>
              <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-medium ${statusBadge[item.status] || statusBadge.open}`}>
                {item.status}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mb-1">{item.category} · {item.created_at?.slice(0, 16).replace('T', ' ')}</p>
            <p className="text-xs text-slate-300 mb-2">{item.message}</p>
            {item.admin_reply && (
              <div className="rounded-lg border border-cyan-800/40 bg-cyan-900/10 px-3 py-2 text-xs text-cyan-200">
                <span className="font-medium text-cyan-300">Admin reply: </span>
                {item.admin_reply}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Admin inbox ───────────────────────────────────────────────────────────
function AdminInbox() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [replyId, setReplyId] = useState(null)
  const [replyText, setReplyText] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('all')

  async function load() {
    setLoading(true)
    try {
      const data = await apiJson('/api/feedback')
      setItems(data.feedback || [])
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function sendReply(id) {
    if (!replyText.trim()) return
    setSaving(true)
    try {
      await apiJson(`/api/feedback/${id}/reply`, {
        method: 'PATCH',
        body: JSON.stringify({ reply: replyText }),
      })
      setReplyId(null)
      setReplyText('')
      load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function setStatus(id, status) {
    try {
      await apiJson(`/api/feedback/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      load()
    } catch (e) {
      setErr(e.message)
    }
  }

  const filtered = filter === 'all' ? items : items.filter(i => i.status === filter)
  const counts = {
    open: items.filter(i => i.status === 'open').length,
    replied: items.filter(i => i.status === 'replied').length,
    closed: items.filter(i => i.status === 'closed').length,
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold">Feedback Inbox</h2>
        <div className="flex gap-1.5 flex-wrap text-xs">
          {['all', 'open', 'replied', 'closed'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg border px-2.5 py-1 capitalize transition ${
                filter === f
                  ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                  : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-500'
              }`}
            >
              {f}{f !== 'all' && counts[f] != null ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="mb-2 text-xs text-rose-300">{err}</p>}
      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {!loading && filtered.length === 0 && (
        <p className="text-sm text-slate-500">No feedback in this category.</p>
      )}

      <div className="space-y-3">
        {filtered.map(item => (
          <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
            <div className="mb-1 flex items-start justify-between gap-2 flex-wrap">
              <div>
                <span className="font-medium text-slate-100 text-sm">{item.title}</span>
                <span className="ml-2 text-[10px] text-slate-500">{item.category}</span>
              </div>
              <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-medium ${statusBadge[item.status] || statusBadge.open}`}>
                {item.status}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mb-1">
              From: <span className="text-slate-300">{item.user_name}</span>
              <span className="ml-1 text-slate-600">({item.user_role})</span>
              {' · '}{item.created_at?.slice(0, 16).replace('T', ' ')}
            </p>
            <p className="text-xs text-slate-300 mb-2">{item.message}</p>

            {item.admin_reply && (
              <div className="mb-2 rounded-lg border border-cyan-800/40 bg-cyan-900/10 px-3 py-2 text-xs text-cyan-200">
                <span className="font-medium text-cyan-300">Your reply: </span>
                {item.admin_reply}
              </div>
            )}

            {/* Reply form */}
            {replyId === item.id ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  rows={3}
                  placeholder="Type your reply…"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none resize-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => sendReply(item.id)}
                    disabled={saving || !replyText.trim()}
                    className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
                  >
                    {saving ? 'Sending…' : 'Send Reply'}
                  </button>
                  <button
                    onClick={() => { setReplyId(null); setReplyText('') }}
                    className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap mt-1">
                <button
                  onClick={() => { setReplyId(item.id); setReplyText(item.admin_reply || '') }}
                  className="rounded border border-slate-600 px-2.5 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
                >
                  {item.admin_reply ? 'Edit reply' : 'Reply'}
                </button>
                {item.status !== 'closed' && (
                  <button
                    onClick={() => setStatus(item.id, 'closed')}
                    className="rounded border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400 hover:bg-slate-800"
                  >
                    Mark closed
                  </button>
                )}
                {item.status === 'closed' && (
                  <button
                    onClick={() => setStatus(item.id, 'open')}
                    className="rounded border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400 hover:bg-slate-800"
                  >
                    Reopen
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function FeedbackPage() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)

  if (!user) return null

  if (user.role === 'admin') {
    return (
      <div className="space-y-6 mx-auto max-w-3xl">
        <AdminInbox />
      </div>
    )
  }

  return (
    <div className="space-y-6 mx-auto max-w-2xl">
      <SubmitForm onSubmitted={() => setRefreshKey(k => k + 1)} />
      <MyFeedback refresh={refreshKey} />
    </div>
  )
}
