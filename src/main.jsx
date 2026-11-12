import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import './index.css'

const YT = 'https://brightan.myjetbrains.com/youtrack/issue/'
// Next Thursday (today if Thursday), local time, as YYYY-MM-DD.
const nextThursday = () => {
  const d = new Date()
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Row({ t, onDone }) {
  const [date, setDate] = useState(nextThursday())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setBusy(true); setErr('')
    const r = await fetch(`/api/tickets/${t.id}/due`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
    })
    setBusy(false)
    if (r.ok) onDone(t.id)
    else {
      const e = await r.json().catch(() => ({}))
      setErr(e.error_description || e.error || `Save failed (${r.status})`)
    }
  }
  return (
    <tr>
      <td className="id"><a href={YT + t.id} target="_blank" rel="noreferrer">{t.id}</a></td>
      <td className="sum" data-label="Summary">{t.summary}</td>
      <td data-label="Assignee">{t.assignee ?? 'Unassigned'}</td>
      <td className="act" data-label="Due date">
        <input type="date" aria-label={`Due date for ${t.id}`} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="primary" disabled={busy || !date} onClick={save}>{busy ? 'Saving…' : 'Set due date'}</button>
        {err && <span className="err" role="alert">{err}</span>}
      </td>
    </tr>
  )
}

function App() {
  const [tickets, setTickets] = useState(null)
  const [error, setError] = useState('')
  const load = () => {
    setTickets(null); setError('')
    fetch('/api/tickets').then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setTickets).catch((e) => setError(`Load failed (${e})`))
  }
  useEffect(load, [])
  return (
    <main>
      <header>
        <div>
          <h1>Missing due dates{tickets?.length > 0 && <span className="count">{tickets.length}</span>}</h1>
          <p className="sub">Jobseeker App Delivery · Current sprint · In Preparation</p>
        </div>
        <button className="ghost" onClick={load}>Refresh</button>
      </header>
      <div className="card">
        {error && <p className="state err" role="alert">{error}</p>}
        {!tickets && !error && (
          <div className="state" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => <div key={i} className="sk" style={{ margin: '16px auto', width: `${90 - i * 15}%` }} />)}
          </div>
        )}
        {tickets && (tickets.length === 0 ? <div className="empty" role="status">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m8 12.5 2.8 2.8L16 9.5" /></svg>
            <p><strong>All caught up</strong><br />No tickets in this sprint's In Preparation are missing a due date.</p>
          </div> : (
          <div className="scroll">
            <table>
              <thead><tr><th scope="col">ID</th><th scope="col">Summary</th><th scope="col">Assignee</th><th scope="col">Due date</th></tr></thead>
              <tbody>{tickets.map((t) => <Row key={t.id} t={t} onDone={(id) => setTickets((l) => l.filter((x) => x.id !== id))} />)}</tbody>
            </table>
          </div>
        ))}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
