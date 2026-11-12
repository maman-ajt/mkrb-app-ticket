// Personal YouTrack token, encrypted at rest in the browser.
// AES-GCM with a NON-extractable key kept in IndexedDB: the localStorage value alone is useless
// (copying it, or dumping storage, yields ciphertext). Same-origin script could still decrypt, so
// this is not protection against XSS; it keeps the token out of plain text. Fresh IV per save.
const LS = 'mkrb.yt.token'
const DB = 'mkrb'

const db = () =>
  new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('k')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
const idb = async (mode, fn) => {
  const d = await db()
  return new Promise((res, rej) => {
    const req = fn(d.transaction('k', mode).objectStore('k'))
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
async function key(create) {
  let k = await idb('readonly', (s) => s.get('key'))
  if (!k && create) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await idb('readwrite', (s) => s.put(k, 'key'))
  }
  return k
}
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function saveToken(token) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(true), new TextEncoder().encode(token)))
  localStorage.setItem(LS, b64(iv) + '.' + b64(ct))
}
export async function loadToken() {
  try {
    const v = localStorage.getItem(LS)
    const k = v && (await key(false))
    if (!k) return null
    const [iv, ct] = v.split('.').map(unb64)
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct))
  } catch {
    return null // tampered / key lost: treat as logged out
  }
}
export function clearToken() {
  localStorage.removeItem(LS)
}
