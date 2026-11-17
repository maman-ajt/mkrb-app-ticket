import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const YT = "https://brightan.myjetbrains.com/youtrack";
const BOARD = "Board Jobseeker App Delivery: {Current sprint}";
const QUERY = `${BOARD} has: -{Due Date} State: {In Preparation}`;
// Bulk "move all" transitions for the connected user: current state -> next state.
const NEXT = {
  "Ready for Work": "In Preparation",
  "In Preparation": "In Development",
  "In Development": "Ready for QA",
  "Ready to Deploy": "Completed",
};
// Why a ticket may not move yet, or null. Due date is required before development starts.
const blocked = (t) =>
  t.state === "In Preparation" && !t.due ? "needs a due date" : null;

// Hash first so lengths match, then constant-time compare.
const sha = (v) =>
  createHash("sha256")
    .update(String(v ?? ""))
    .digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

const json = (status, body) => ({ status, body });

// Login sessions: "<expiry ms>.<HMAC of expiry>". The key derives from the app password and server
// token, so changing either logs everyone out. Sent as a Bearer header, never a cookie, so it works
// inside embedded webviews (e.g. Lark) and is not auto-sent cross-site.
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sign = (env, exp) =>
  createHmac("sha256", `session:${env.APP_PASSWORD}:${env.YOUTRACK_TOKEN}`)
    .update(String(exp))
    .digest("base64url");
const validSession = (env, authorization) => {
  const [exp, sig] = String(authorization ?? "").replace(/^Bearer /, "").split(".");
  return Number(exp) > Date.now() && same(sig, sign(env, exp));
};

// Shared by the Vite dev/preview middleware and the Netlify function.
// req: { method, pathname, authorization, contentType, origin, host, body }
// Returns { status, body, headers? }; the token and login never reach the browser.
export async function handle(req, env) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD || !env.YOUTRACK_TOKEN)
    return json(500, { error: "server not configured" });

  // Username/password in, session token out. No WWW-Authenticate anywhere: the app shows its own login page.
  if (req.method === "POST" && req.pathname === "/api/login") {
    if (!req.contentType?.startsWith("application/json")) return json(415, { error: "json only" });
    let username, password;
    try {
      ({ username, password } = JSON.parse(req.body));
    } catch {
      return json(400, { error: "bad json" });
    }
    // Check both, always, so timing does not reveal which one was wrong.
    const ok = same(username, env.APP_USERNAME) & same(password, env.APP_PASSWORD);
    if (!ok) return json(401, { error: "Wrong username or password" });
    const exp = Date.now() + SESSION_MS;
    return json(200, { token: `${exp}.${sign(env, exp)}` });
  }
  if (!validSession(env, req.authorization)) return json(401, { error: "login required" });

  // Due-date list/save always use the server's .env token. Only /api/me/* (move my tickets)
  // passes the visitor's personal token explicitly; it is used per request and never stored.
  const yt = (path, init = {}, token = env.YOUTRACK_TOKEN) =>
    fetch(YT + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

  // CSRF: defence in depth (the Bearer session is never auto-sent). A JSON content type forces a CORS preflight, which we never allow; also reject foreign Origins.
  const csrfBad = () =>
    !req.contentType?.startsWith("application/json") ||
    (req.origin && new URL(req.origin).host !== req.host);

  try {
    if (req.pathname.startsWith("/api/me")) {
      const tok = req.userToken;
      if (!tok || !/^[\w.=:-]{8,300}$/.test(tok))
        return json(403, { error: "Invalid token" });
      const mr = await yt("/api/users/me?fields=login,fullName", {}, tok);
      if (!mr.ok) return json(403, { error: "Invalid token" });
      const me = await mr.json();

      // My tickets in any movable state, assigned to the token's user, with their parent ticket.
      const mine = async () => {
        const states = Object.keys(NEXT).map((s) => `{${s}}`).join(", ");
        const q = `${BOARD} for: me State: ${states}`;
        const r = await yt(
          `/api/issues?query=${encodeURIComponent(q)}&$top=200&fields=idReadable,summary,parent(issues(idReadable,summary,customFields(name,$type,value(name)))),customFields(name,$type,value(name,login))`,
          {},
          tok,
        );
        const data = await r.json();
        if (!r.ok) throw Object.assign(new Error("youtrack"), { status: r.status, data });
        const fields = (i) => {
          const f = (n) => i.customFields?.find((x) => x.name === n);
          return {
            id: i.idReadable,
            summary: i.summary,
            state: f("State")?.value?.name ?? null,
            stateType: f("State")?.$type,
            assignee: f("Assignee")?.value?.login,
            due: f("Due Date")?.value ?? null,
          };
        };
        return data.map((i) => {
          const p = i.parent?.issues?.[0];
          return { ...fields(i), parent: p ? fields(p) : null };
        });
      };

      try {
        if (req.method === "GET" && req.pathname === "/api/me") {
          const list = await mine();
          return json(200, {
            user: { login: me.login, name: me.fullName },
            flow: NEXT,
            tickets: list.map((t) => ({
              id: t.id,
              summary: t.summary,
              parent: t.parent && { id: t.parent.id, summary: t.parent.summary },
              state: t.state,
              blocked: blocked(t),
            })),
          });
        }

        // Move the given tickets (one, a selection, or all) each to the next state after its current one.
        if (req.method === "POST" && req.pathname === "/api/me/move") {
          if (csrfBad()) return json(403, { error: "forbidden" });
          if (req.body.length > 8192) return json(413, { error: "too large" });
          let ids;
          try {
            ({ ids } = JSON.parse(req.body));
          } catch {
            return json(400, { error: "bad json" });
          }
          if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((i) => typeof i === "string"))
            return json(400, { error: "bad ids" });
          const want = new Set(ids);
          const done = {};
          const failed = {};
          // Re-fetch and re-check: only my tickets, still in a movable state, never trust the client.
          const found = (await mine()).filter((t) => want.has(t.id));
          for (const id of want) if (!found.some((t) => t.id === id)) failed[id] = "not yours or not movable";
          const setState = async (t, to) => {
            const r = await yt(
              `/api/issues/${t.id}?fields=id`,
              {
                method: "POST",
                body: JSON.stringify({
                  customFields: [{ name: "State", $type: t.stateType, value: { name: to } }],
                }),
              },
              tok,
            );
            if (r.ok) done[t.id] = to;
            else {
              const e = await r.json().catch(() => ({}));
              failed[t.id] = e.error_description || e.error || `HTTP ${r.status}`;
            }
            return r.ok;
          };
          for (const t of found) {
            const to = Object.hasOwn(NEXT, t.state) ? NEXT[t.state] : null;
            if (t.assignee !== me.login || !t.stateType || !to) {
              failed[t.id] = "not assigned to you";
              continue;
            }
            if (blocked(t)) {
              failed[t.id] = blocked(t);
              continue;
            }
            if (t.id in done) continue; // already moved along with one of its children
            if (!(await setState(t, to))) continue;
            // The parent follows its child: if it sat in the same (not yet Completed) state, move it too.
            const p = t.parent;
            if (p && !(p.id in done) && p.state === t.state && p.stateType && !blocked(p)) await setState(p, to);
          }
          return json(200, { done, failed });
        }
      } catch (e) {
        if (e.status) return json(e.status, e.data);
        throw e;
      }
      return json(404, { error: "not found" });
    }

    if (req.method === "GET" && req.pathname === "/api/tickets") {
      const r = await yt(
        `/api/issues?query=${encodeURIComponent(QUERY)}&$top=200&fields=idReadable,summary,customFields(name,value(name))`,
      );
      const data = await r.json();
      if (!r.ok) return json(r.status, data);
      return json(
        200,
        data.map((i) => ({
          id: i.idReadable,
          summary: i.summary,
          assignee:
            i.customFields?.find((f) => f.name === "Assignee")?.value?.name ??
            null,
        })),
      );
    }

    // Per-developer load for the current sprint: ticket count and story points, Ready for Work excluded.
    if (req.method === "GET" && req.pathname === "/api/dashboard") {
      const q = `${BOARD} State: -{Ready for Work}`;
      const issues = [];
      for (let skip = 0; ; skip += 200) {
        const r = await yt(
          `/api/issues?query=${encodeURIComponent(q)}&$top=200&$skip=${skip}&fields=customFields(name,value(name))`,
        );
        const data = await r.json();
        if (!r.ok) return json(r.status, data);
        issues.push(...data);
        if (data.length < 200) break;
      }
      const by = new Map();
      for (const i of issues) {
        const f = (n) => i.customFields?.find((x) => x.name === n)?.value;
        const name = f("Assignee")?.name ?? null;
        const row = by.get(name) ?? { name, tickets: 0, sp: 0 };
        row.tickets += 1;
        row.sp += Number(f("Story Points")) || 0;
        by.set(name, row);
      }
      return json(200, [...by.values()].sort((a, b) => b.sp - a.sp || b.tickets - a.tickets));
    }

    const m = req.pathname.match(/^\/api\/tickets\/([\w-]+)\/due$/);
    if (req.method === "POST" && m) {
      if (csrfBad()) return json(403, { error: "forbidden" });
      if (req.body.length > 1024) return json(413, { error: "too large" });
      let date;
      try {
        ({ date } = JSON.parse(req.body)); // YYYY-MM-DD
      } catch {
        return json(400, { error: "bad json" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return json(400, { error: "bad date" });
      // YouTrack rejects customFields without $type, and it depends on the field kind: resolve it from the issue first.
      const tr = await yt(
        `/api/issues/${m[1]}?fields=customFields(name,$type)`,
      );
      if (!tr.ok) return json(tr.status, await tr.json());
      const type = (await tr.json()).customFields?.find(
        (f) => f.name === "Due Date",
      )?.$type;
      if (!type)
        return json(400, {
          error: 'unknown custom field "Due Date" on issue ' + m[1],
        });
      const r = await yt(`/api/issues/${m[1]}?fields=id`, {
        method: "POST",
        body: JSON.stringify({
          customFields: [
            {
              name: "Due Date",
              $type: type,
              value: Date.parse(date + "T00:00:00Z"),
            },
          ],
        }),
      });
      return json(r.ok ? 200 : r.status, r.ok ? { ok: true } : await r.json());
    }
  } catch (e) {
    return json(500, { error: String(e) });
  }
  return json(404, { error: "not found" });
}
