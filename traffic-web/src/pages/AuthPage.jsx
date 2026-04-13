import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

function safeReturnPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  if (raw === '/auth') return '/dashboard'
  return raw
}

export default function AuthPage() {
  const { user, loading, login, register } = useAuth()
  const location = useLocation()
  const returnTo = safeReturnPath(location.state?.from)

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [signupName, setSignupName] = useState('')
  const [signupEmail, setSignupEmail] = useState('')
  const [signupPassword, setSignupPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onLogin(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(loginEmail, loginPassword)
    } catch (err) {
      setError(err.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  async function onSignup(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await register(signupName, signupEmail, signupPassword)
    } catch (err) {
      setError(err.message || 'Signup failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-slate-400">
        Checking your session…
      </div>
    )
  }

  if (user) {
    return <Navigate to={returnTo} replace />
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 lg:col-span-2">
        <h2 className="text-lg font-semibold text-slate-100">Welcome</h2>
        <p className="mt-2 text-sm text-slate-400">Sign in below, or create an account.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-800/50 bg-rose-950/40 p-3 text-sm text-rose-200 lg:col-span-2">{error}</div>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-lg font-semibold">Login</h2>
        <form className="space-y-3" onSubmit={onLogin}>
          <input
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            placeholder="Email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          />
          <input
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="Password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-cyan-500 py-2 font-semibold text-slate-950 disabled:opacity-50"
          >
            {busy ? 'Please wait…' : 'Login'}
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <h2 className="mb-3 text-lg font-semibold">Signup</h2>
        <form className="space-y-3" onSubmit={onSignup}>
          <input
            value={signupName}
            onChange={(e) => setSignupName(e.target.value)}
            placeholder="Name"
            required
            autoComplete="name"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          />
          <input
            value={signupEmail}
            onChange={(e) => setSignupEmail(e.target.value)}
            placeholder="Email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          />
          <input
            value={signupPassword}
            onChange={(e) => setSignupPassword(e.target.value)}
            placeholder="Password (min 6 characters)"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-emerald-500 py-2 font-semibold text-slate-950 disabled:opacity-50"
          >
            {busy ? 'Please wait…' : 'Create Account'}
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 lg:col-span-2">
        <h3 className="mb-2 text-md font-semibold">Saved routes</h3>
        <p className="text-sm text-slate-400">
          After you sign in, save and review trips from the <span className="text-slate-300">Route Planner</span> page.
        </p>
      </section>
    </div>
  )
}
