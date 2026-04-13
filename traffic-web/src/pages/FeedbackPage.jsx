export default function FeedbackPage() {
  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="mb-3 text-lg font-semibold">Feedback & Issue Reporting</h2>
      <p className="mb-4 text-sm text-slate-400">Report traffic issues, accidents, or road conditions directly to authorities.</p>
      <div className="space-y-3">
        <input className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Title (e.g., Accident near Sector 9)" />
        <select className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2">
          <option>Traffic Issue</option>
          <option>Accident</option>
          <option>Roadblock</option>
          <option>Signal Malfunction</option>
        </select>
        <textarea className="h-32 w-full rounded-lg border border-slate-700 bg-slate-950 p-2" placeholder="Describe issue..." />
        <button className="rounded-lg bg-cyan-500 px-4 py-2 font-semibold text-slate-950">Submit Feedback</button>
      </div>
    </section>
  )
}
