import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState } from 'react'
import { clearToken, loadToken, saveToken } from './tokenStore.js'
import './index.css'

const YT = 'https://brightan.myjetbrains.com/youtrack/issue/'
const NONE = 'Unassigned'

// Next Thursday (today if Thursday), local time, as YYYY-MM-DD.
const nextThursday = () => {
  const d = new Date()
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Returns '' on success, else the error message.
async function setDue(id, date) {
  try {
    const r = await fetch(`/api/tickets/${id}/due`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    })
    if (r.ok) return ''
    const e = await r.json().catch(() => ({}))
    return e.error_description || e.error || `Save failed (${r.status})`
  } catch {
    return 'Network error'
  }
}

function Check({ checked, indeterminate = false, onChange, label }) {
  return (
    <input
      type="checkbox"
      className="chk"
      aria-label={label}
      checked={checked}
      ref={(el) => el && (el.indeterminate = indeterminate)}
      onChange={onChange}
    />
  )
}

function Row({ t, checked, onToggle, onDone }) {
  const [date, setDate] = useState(nextThursday())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async () => {
    setBusy(true)
    setErr('')
    const e = await setDue(t.id, date)
    setBusy(false)
    if (e) setErr(e)
    else onDone([t.id])
  }
  return (
    <tr className={checked ? 'sel' : ''}>
      <td className="pick"><Check checked={checked} onChange={onToggle} label={`Select ${t.id}`} /></td>
      <td className="id"><a href={YT + t.id} target="_blank" rel="noreferrer">{t.id}</a></td>
      <td className="sum" data-label="Summary">{t.summary}</td>
      <td className="act" data-label="Due date">
        <input type="date" aria-label={`Due date for ${t.id}`} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="primary" disabled={busy || !date} onClick={save}>{busy ? 'Saving…' : 'Set due date'}</button>
        {err && <span className="err" role="alert">{err}</span>}
      </td>
    </tr>
  )
}

function MyTickets() {
  const [input, setInput] = useState('')
  const [token, setToken] = useState(null)
  const [me, setMe] = useState(null)
  const [list, setList] = useState([])
  const [err, setErr] = useState('')
  const [rowErr, setRowErr] = useState({})
  const [busy, setBusy] = useState(false)

  const call = (path, tok, init = {}) =>
    fetch(path, { ...init, headers: { 'Content-Type': 'application/json', 'X-YouTrack-Token': tok } })

  const connect = async (tok, persist) => {
    setBusy(true)
    setErr('')
    try {
      const r = await call('/api/me', tok)
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Failed (${r.status})`)
      const d = await r.json()
      if (persist) await saveToken(tok)
      setToken(tok)
      setMe(d.user)
      setList(d.tickets)
      setInput('')
    } catch (e) {
      setErr(e.message)
      if (!persist) clearToken() // stored token went bad
    }
    setBusy(false)
  }
  useEffect(() => {
    loadToken().then((t) => t && connect(t, false))
  }, [])

  const logout = () => {
    clearToken()
    setToken(null)
    setMe(null)
    setList([])
    setRowErr({})
  }
  const complete = async (id) => {
    setRowErr((e) => ({ ...e, [id]: '' }))
    const r = await call(`/api/me/tickets/${id}/complete`, token, { method: 'POST', body: '{}' })
    if (r.ok) return setList((l) => l.filter((t) => t.id !== id))
    const e = await r.json().catch(() => ({}))
    setRowErr((x) => ({ ...x, [id]: e.error_description || e.error || `Failed (${r.status})` }))
  }
  const completeAll = async () => {
    if (!confirm(`Move ${list.length} ticket(s) to Completed?`)) return
    setBusy(true)
    for (const t of list) await complete(t.id)
    setBusy(false)
  }

  return (
    <section className="card me" aria-label="My tickets">
      {!me ? (
        <form
          className="tok"
          onSubmit={(e) => {
            e.preventDefault()
            connect(input.trim(), true)
          }}
        >
          <label htmlFor="tok">
            <strong>Your YouTrack token</strong>
            <span className="hint">Create one in YouTrack: Profile, Account Security, New token. Stored encrypted in this browser.</span>
          </label>
          <div className="tokrow">
            <input id="tok" type="password" autoComplete="off" placeholder="perm:…" value={input} onChange={(e) => setInput(e.target.value)} />
            <button className="primary" disabled={busy || !input.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
          </div>
          {err && <p className="err" role="alert">{err}</p>}
        </form>
      ) : (
        <>
          <div className="mehead">
            <div>
              <strong>{me.name}</strong> <span className="hint">@{me.login} · your tickets not Completed</span>
            </div>
            <div className="mebtns">
              {list.length > 0 && <button className="primary" disabled={busy} onClick={completeAll}>{busy ? 'Working…' : `Complete all ${list.length}`}</button>}
              <button className="ghost" onClick={logout}>Disconnect</button>
            </div>
          </div>
          {list.length === 0 ? (
            <p className="empty" role="status">Nothing left to complete.</p>
          ) : (
            <ul className="mylist">
              {list.map((t) => (
                <li key={t.id}>
                  <a href={YT + t.id} target="_blank" rel="noreferrer">{t.id}</a>
                  <span className="sum">{t.summary}</span>
                  <span className="st">{t.state}</span>
                  <button className="ghost" disabled={busy} onClick={() => complete(t.id)}>Mark completed</button>
                  {rowErr[t.id] && <span className="err" role="alert">{rowErr[t.id]}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function App() {
  const [tickets, setTickets] = useState(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const [bulkDate, setBulkDate] = useState(nextThursday())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkErr, setBulkErr] = useState('')

  const load = () => {
    setTickets(null)
    setError('')
    setSel(new Set())
    fetch('/api/tickets')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setTickets)
      .catch((e) => setError(`Load failed (${e})`))
  }
  useEffect(load, [])

  const groups = useMemo(() => {
    const m = new Map()
    for (const t of tickets ?? []) {
      const k = t.assignee ?? NONE
      m.set(k, [...(m.get(k) ?? []), t])
    }
    return [...m].sort(([a], [b]) => (a === NONE) - (b === NONE) || a.localeCompare(b))
  }, [tickets])

  const remove = (ids) => {
    setTickets((l) => l.filter((x) => !ids.includes(x.id)))
    setSel((s) => new Set([...s].filter((i) => !ids.includes(i))))
  }
  const toggle = (ids, on) =>
    setSel((s) => {
      const n = new Set(s)
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)))
      return n
    })

  const bulkSave = async () => {
    const ids = [...sel]
    setBulkBusy(true)
    setBulkErr('')
    const done = []
    const failed = []
    for (let i = 0; i < ids.length; i += 4) {
      const chunk = ids.slice(i, i + 4)
      const res = await Promise.all(chunk.map((id) => setDue(id, bulkDate)))
      res.forEach((e, j) => (e ? failed.push(`${chunk[j]}: ${e}`) : done.push(chunk[j])))
    }
    setBulkBusy(false)
    remove(done)
    if (failed.length) setBulkErr(`${failed.length} failed. ${failed.slice(0, 3).join('; ')}`)
  }

  const all = tickets?.map((t) => t.id) ?? []
  const allOn = all.length > 0 && sel.size === all.length

  return (
    <main>
      <header>
        <div>
          <h1>Missing due dates{tickets?.length > 0 && <span className="count">{tickets.length}</span>}</h1>
          <p className="sub">Jobseeker App Delivery · Current sprint · In Preparation</p>
        </div>
        <button className="ghost" onClick={load}>Refresh</button>
      </header>

      {tickets?.length > 0 && (
        <div className="bulk card" role="region" aria-label="Bulk actions">
          <label className="all">
            <Check checked={allOn} indeterminate={sel.size > 0 && !allOn} onChange={(e) => toggle(all, e.target.checked)} label="Select all tickets" />
            {sel.size ? `${sel.size} selected` : 'Select all'}
          </label>
          <input type="date" aria-label="Due date for selected tickets" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} />
          <button className="primary" disabled={!sel.size || !bulkDate || bulkBusy} onClick={bulkSave}>
            {bulkBusy ? 'Saving…' : `Set due date${sel.size ? ` for ${sel.size}` : ''}`}
          </button>
          {bulkErr && <span className="err" role="alert">{bulkErr}</span>}
        </div>
      )}

      <div className="card">
        {error && <p className="state err" role="alert">{error}</p>}
        {!tickets && !error && (
          <div className="state" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => <div key={i} className="sk" style={{ margin: '16px auto', width: `${90 - i * 15}%` }} />)}
          </div>
        )}
        {tickets && (tickets.length === 0 ? (
          <div className="empty" role="status">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m8 12.5 2.8 2.8L16 9.5" /></svg>
            <p><strong>All caught up</strong><br />No tickets in this sprint's In Preparation are missing a due date.</p>
          </div>
        ) : (
          <div className="scroll">
            <table>
              <thead><tr><th className="pick" /><th scope="col">ID</th><th scope="col">Summary</th><th scope="col">Due date</th></tr></thead>
              {groups.map(([who, list]) => {
                const ids = list.map((t) => t.id)
                const n = ids.filter((i) => sel.has(i)).length
                return (
                  <tbody key={who}>
                    <tr className="grp">
                      <td colSpan={4}>
                        <label>
                          <Check checked={n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={(e) => toggle(ids, e.target.checked)} label={`Select all of ${who}`} />
                          <strong>{who}</strong>
                          <span className="count">{ids.length}</span>
                        </label>
                      </td>
                    </tr>
                    {list.map((t) => (
                      <Row key={t.id} t={t} checked={sel.has(t.id)} onToggle={(e) => toggle([t.id], e.target.checked)} onDone={remove} />
                    ))}
                  </tbody>
                )
              })}
            </table>
          </div>
        ))}
      </div>
      <MyTickets />
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
