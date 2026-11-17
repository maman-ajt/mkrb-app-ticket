import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState } from 'react'
import { clearToken, loadToken, saveToken } from './tokenStore.js'
import './index.css'

const YT = 'https://brightan.myjetbrains.com/youtrack/issue/'
const NONE = 'Unassigned'

// Brand themes; colors here only feed the favicon, page colors live in index.css.
const THEMES = { ajt: ['AJobThing', '#FAA221', '#111827'], rb: ['Ricebowl', '#25A67F', '#111827'], mk: ['Maukerja', '#D62F40', '#fff'] }
const store = {
  get: () => { try { return localStorage.getItem('theme') } catch { return null } },
  set: (v) => { try { localStorage.setItem('theme', v) } catch { /* private mode */ } },
}
const applyTheme = (k) => {
  const [, bg, fg] = THEMES[k]
  document.documentElement.dataset.theme = k
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${bg}"/><path d="M6 11a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V21a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/><path d="M20 10v12" stroke="${fg}" stroke-width="2" stroke-dasharray="2 2"/></svg>`
  document.getElementById('fav').href = 'data:image/svg+xml,' + encodeURIComponent(svg)
}
const initialTheme = THEMES[store.get()] ? store.get() : 'ajt'
applyTheme(initialTheme)

function ThemePicker() {
  const [theme, setTheme] = useState(initialTheme)
  const pick = (k) => {
    setTheme(k)
    applyTheme(k)
    store.set(k)
  }
  return (
    <select aria-label="Theme" value={theme} onChange={(e) => pick(e.target.value)}>
      {Object.entries(THEMES).map(([k, [name]]) => <option key={k} value={k}>{name}</option>)}
    </select>
  )
}

// Native confirm() is silently blocked in sandboxed iframes (e.g. VS Code Simple Browser), so use <dialog>.
// Resolves true only on the primary button; Esc/Cancel resolve false.
const ask = (msg, ok) => new Promise((resolve) => {
  const d = document.createElement('dialog')
  d.className = 'dlg'
  d.innerHTML = '<p></p><form method="dialog"><button class="ghost" value="">Cancel</button><button class="primary" value="ok"></button></form>'
  d.querySelector('p').textContent = msg
  d.querySelector('.primary').textContent = ok
  d.addEventListener('close', () => {
    resolve(d.returnValue === 'ok')
    d.remove()
  })
  document.body.append(d)
  d.showModal()
})

const unassignedOk = async (n) => !n || ask(`${n} ticket(s) have no assignee. Set due date anyway?`, 'Set due date')

// Next Thursday (today if Thursday), local time, as YYYY-MM-DD.
const nextThursday = () => {
  const d = new Date()
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// App login session (not the YouTrack token). A 401 anywhere drops it and shows the login page.
const SESSION = 'session'
const session = {
  get: () => { try { return localStorage.getItem(SESSION) } catch { return null } },
  set: (v) => { try { localStorage.setItem(SESSION, v) } catch { /* private mode: lasts this page only */ } },
  clear: () => { try { localStorage.removeItem(SESSION) } catch { /* ignore */ } },
}
const api = async (path, init = {}) => {
  const r = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${session.get()}` } })
  // Only our own session check logs out; a 401 passed through from YouTrack must not.
  if (r.status === 401 && (await r.clone().json().catch(() => ({}))).error === 'login required') {
    session.clear()
    window.dispatchEvent(new Event('logout'))
  }
  return r
}

function Login({ onIn }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || `Login failed (${r.status})`)
      session.set(d.token)
      onIn()
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <h1>Sign in</h1>
        <label htmlFor="lu">Username</label>
        <input id="lu" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label htmlFor="lp">Password</label>
        <input id="lp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  )
}

// Returns '' on success, else the error message.
async function setDue(id, date) {
  try {
    const r = await api(`/api/tickets/${id}/due`, {
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
    if (!(await unassignedOk(t.assignee ? 0 : 1))) return
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
  const [flow, setFlow] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const call = (path, tok, init = {}) =>
    api(path, { ...init, headers: { 'Content-Type': 'application/json', 'X-YouTrack-Token': tok } })

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
      setFlow(d.flow)
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
  }
  const [sel, setSel] = useState(() => new Set())
  const toggle = (ids, on) => setSel((s) => {
    const c = new Set(s)
    ids.forEach((i) => (on ? c.add(i) : c.delete(i)))
    return c
  })
  // Group by parent: key is the parent's id, or the ticket's own id (so a parent sits with its children).
  // Lone tickets with no parent and no children go together under "No parent".
  // Closest to done first: Ready to Deploy on top, Ready for Work last (reverse of the flow order).
  const groups = useMemo(() => {
    const order = Object.keys(flow)
    const rank = (t) => -order.indexOf(t.state)
    const m = new Map()
    for (const t of [...list].sort((x, y) => rank(x) - rank(y))) {
      const k = t.parent?.id ?? t.id
      if (!m.has(k)) m.set(k, { id: k, summary: t.parent?.summary ?? t.summary, items: [] })
      m.get(k).items.push(t)
    }
    const out = []
    const lone = { id: null, summary: 'No parent', items: [] }
    for (const g of m.values()) {
      if (g.items.length === 1 && g.items[0].id === g.id) lone.items.push(g.items[0])
      else out.push({ ...g, items: g.items.sort((x, y) => (x.id === g.id ? -1 : y.id === g.id ? 1 : 0)) })
    }
    if (lone.items.length) out.push(lone)
    const best = (g) => Math.min(...g.items.map(rank))
    return out.sort((x, y) => best(x) - best(y))
  }, [list, flow])
  const [closed, setClosed] = useState(() => new Set())

  const move = async (ids, what) => {
    if (ids.length > 1 && !(await ask(`Move ${what} (${ids.length} tickets) to their next state?`, 'Move'))) return
    setBusy(true)
    setErr('')
    try {
      const r = await call('/api/me/move', token, { method: 'POST', body: JSON.stringify({ ids }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error_description || d.error || `Failed (${r.status})`)
      // Reload so moved tickets show their new state and blockers (e.g. now In Preparation without a due date).
      const fresh = await call('/api/me', token)
      if (fresh.ok) setList((await fresh.json()).tickets)
      else setList((l) => l.filter((t) => !(t.id in d.done)))
      setSel((s) => new Set([...s].filter((i) => !(i in d.done))))
      const f = Object.entries(d.failed)
      if (f.length) setErr(`${f.length} failed: ${f.slice(0, 3).map(([id, m]) => `${id} (${m})`).join('; ')}`)
    } catch (e) {
      setErr(e.message)
    }
    setBusy(false)
  }
  // Server-reported blockers (e.g. In Preparation without a due date) can't move; keep them out of bulk moves.
  const all = list.filter((t) => !t.blocked).map((t) => t.id)
  const picked = all.filter((i) => sel.has(i))

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
              <strong>{me.name}</strong> <span className="hint">@{me.login} · your tickets ready to move</span>
            </div>
            <div className="mebtns">
              <button className="ghost" onClick={logout}>Disconnect</button>
            </div>
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          {list.length === 0 ? (
            <p className="empty" role="status">No tickets to move.</p>
          ) : (
            <>
              <div className="bulk card mymove" role="region" aria-label="Move actions">
                <label className="all">
                  <Check checked={all.length > 0 && picked.length === all.length} indeterminate={picked.length > 0 && picked.length < all.length} onChange={(e) => toggle(all, e.target.checked)} label="Select all my tickets" />
                  {picked.length ? `${picked.length} selected` : 'Select all'}
                </label>
                <button className="primary" disabled={busy || !picked.length} onClick={() => move(picked, 'selected')}>{busy ? 'Working…' : `Move selected${picked.length ? ` (${picked.length})` : ''}`}</button>
                <button className="ghost" disabled={busy || !all.length} onClick={() => move(all, 'all')}>Move all ({all.length})</button>
              </div>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="pick" />
                      <th scope="col">ID</th><th scope="col">Summary</th><th scope="col">State</th><th scope="col"><span className="sr">Move</span></th>
                    </tr>
                  </thead>
                  {groups.map((g) => {
                    const ids = g.items.filter((t) => !t.blocked).map((t) => t.id)
                    const n = ids.filter((i) => sel.has(i)).length
                    const key = g.id ?? 'lone'
                    const open = !closed.has(key)
                    const name = g.id ?? 'No parent'
                    const flip = () => setClosed((s) => {
                      const c = new Set(s)
                      if (open) c.add(key)
                      else c.delete(key)
                      return c
                    })
                    return (
                      <tbody key={key}>
                        <tr className="grp">
                          <td colSpan={5}><div className="gb">
                            <button className="exp" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} onClick={flip}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                            </button>
                            <label>
                              {ids.length > 0 && <Check checked={n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={(e) => toggle(ids, e.target.checked)} label={`Select all under ${name}`} />}
                              {g.id && <a href={YT + g.id} target="_blank" rel="noreferrer">{g.id}</a>} <strong>{g.summary}</strong>
                              <span className="count">{g.items.length}</span>
                            </label>
                          </div></td>
                        </tr>
                        {open && g.items.map((t) => (
                          <tr key={t.id} className={t.id !== g.id && g.id ? 'child' : undefined}>
                            <td className="pick">{!t.blocked && <Check checked={sel.has(t.id)} onChange={(e) => toggle([t.id], e.target.checked)} label={`Select ${t.id}`} />}</td>
                            <td><a href={YT + t.id} target="_blank" rel="noreferrer">{t.id}</a></td>
                            <td>{t.summary}</td>
                            <td><span className="st">{t.state}</span></td>
                            <td>{t.blocked ? <span className="hint">Can't move: {t.blocked}</span> : <button className="ghost" disabled={busy} onClick={() => move([t.id])}>To {flow[t.state]}</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    )
                  })}
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

// Current sprint load per developer (Ready for Work not counted).
function Dashboard() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api('/api/dashboard')
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error_description || d.error || `Failed (${r.status})`)
        setRows(d)
      })
      .catch((e) => setError(e.message))
  }, [])
  const total = (k) => rows.reduce((s, r) => s + r[k], 0)
  return (
    <section className="card dash" aria-labelledby="dash-h">
      <h2 id="dash-h">Sprint load per developer <span className="hint">Ready for Work not counted</span></h2>
      {error && <p className="err" role="alert">{error}</p>}
      {!rows && !error && <div className="sk" aria-busy="true" aria-label="Loading" />}
      {rows && (
        <div className="scroll">
          <table>
            <thead><tr><th scope="col">Developer</th><th scope="col" className="num">Tickets</th><th scope="col" className="num">SP</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name ?? NONE}><td>{r.name ?? NONE}</td><td className="num">{r.tickets}</td><td className="num">{r.sp}</td></tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><th className="num">{total('tickets')}</th><th className="num">{total('sp')}</th></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

function Board() {
  const [tickets, setTickets] = useState(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const [bulkDate, setBulkDate] = useState(nextThursday())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkErr, setBulkErr] = useState('')
  const [closed, setClosed] = useState(() => new Set())

  const load = () => {
    setTickets(null)
    setError('')
    setSel(new Set())
    api('/api/tickets')
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
    if (!(await unassignedOk(tickets.filter((t) => sel.has(t.id) && !t.assignee).length))) return
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
        <div className="hbtns">
          <ThemePicker />
          <button className="ghost" onClick={load}>Refresh</button>
          <button className="ghost" onClick={() => { session.clear(); window.dispatchEvent(new Event('logout')) }}>Log out</button>
        </div>
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
                const open = !closed.has(who)
                const flip = () => setClosed((s) => {
                  const c = new Set(s)
                  if (open) c.add(who)
                  else c.delete(who)
                  return c
                })
                return (
                  <tbody key={who}>
                    <tr className="grp">
                      <td colSpan={4}><div className="gb">
                        <button className="exp" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${who}`} onClick={flip}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                        </button>
                        <label>
                          <Check checked={n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={(e) => toggle(ids, e.target.checked)} label={`Select all of ${who}`} />
                          <strong>{who}</strong>
                          <span className="count">{ids.length}</span>
                        </label>
                      </div></td>
                    </tr>
                    {open && list.map((t) => (
                      <Row key={t.id} t={t} checked={sel.has(t.id)} onToggle={(e) => toggle([t.id], e.target.checked)} onDone={remove} />
                    ))}
                  </tbody>
                )
              })}
            </table>
          </div>
        ))}
      </div>
      <Dashboard />
      <MyTickets />
    </main>
  )
}

function App() {
  const [inside, setInside] = useState(() => !!session.get())
  useEffect(() => {
    const out = () => setInside(false)
    window.addEventListener('logout', out)
    return () => window.removeEventListener('logout', out)
  }, [])
  return inside ? <Board /> : <Login onIn={() => setInside(true)} />
}

createRoot(document.getElementById('root')).render(<App />)
