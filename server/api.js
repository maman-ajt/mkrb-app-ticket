import { createHash, timingSafeEqual } from "node:crypto";

const YT = "https://brightan.myjetbrains.com/youtrack";
const BOARD = "Board Jobseeker App Delivery: {Current sprint}";
const QUERY = `${BOARD} has: -{Due Date} State: {In Preparation}`;

// Hash first so lengths match, then constant-time compare.
const sha = (v) =>
  createHash("sha256")
    .update(String(v ?? ""))
    .digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

const json = (status, body) => ({ status, body });

// Shared by the Vite dev/preview middleware and the Netlify function.
// req: { method, pathname, authorization, contentType, origin, host, body }
// Returns { status, body, headers? }; the token and login never reach the browser.
export async function handle(req, env) {
  const auth =
    "Basic " +
    Buffer.from(`${env.APP_USERNAME}:${env.APP_PASSWORD}`).toString("base64");
  if (!env.APP_USERNAME || !env.APP_PASSWORD || !env.YOUTRACK_TOKEN)
    return json(500, { error: "server not configured" });
  if (!same(req.authorization, auth))
    return {
      status: 401,
      body: "Auth required",
      headers: { "WWW-Authenticate": 'Basic realm="tickets"' },
    };

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

  // CSRF: Basic creds are auto-sent cross-site. A JSON content type forces a CORS preflight, which we never allow; also reject foreign Origins.
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

      // My tickets waiting to ship: assigned to the token's user, in Ready to Deploy.
      const mine = async () => {
        const q = `${BOARD} for: me State: {Ready to Deploy}`;
        const r = await yt(
          `/api/issues?query=${encodeURIComponent(q)}&$top=200&fields=idReadable,summary,customFields(name,$type,value(name,login))`,
          {},
          tok,
        );
        const data = await r.json();
        if (!r.ok) throw Object.assign(new Error("youtrack"), { status: r.status, data });
        return data.map((i) => {
          const f = (n) => i.customFields?.find((x) => x.name === n);
          return {
            id: i.idReadable,
            summary: i.summary,
            state: f("State")?.value?.name ?? null,
            stateType: f("State")?.$type,
            assignee: f("Assignee")?.value?.login,
          };
        });
      };

      try {
        if (req.method === "GET" && req.pathname === "/api/me") {
          const list = await mine();
          return json(200, {
            user: { login: me.login, name: me.fullName },
            tickets: list.map(({ id, summary, state }) => ({ id, summary, state })),
          });
        }

        // Move every one of my Ready to Deploy tickets to Completed in one request.
        if (req.method === "POST" && req.pathname === "/api/me/complete-all") {
          if (csrfBad()) return json(403, { error: "forbidden" });
          const done = [];
          const failed = {};
          for (const t of await mine()) {
            // Only the assignee may complete: re-check, never trust the search alone.
            if (t.assignee !== me.login || !t.stateType) {
              failed[t.id] = "not assigned to you";
              continue;
            }
            const r = await yt(
              `/api/issues/${t.id}?fields=id`,
              {
                method: "POST",
                body: JSON.stringify({
                  customFields: [
                    { name: "State", $type: t.stateType, value: { name: "Completed" } },
                  ],
                }),
              },
              tok,
            );
            if (r.ok) done.push(t.id);
            else {
              const e = await r.json().catch(() => ({}));
              failed[t.id] = e.error_description || e.error || `HTTP ${r.status}`;
            }
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
