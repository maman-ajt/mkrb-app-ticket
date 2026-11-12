import { createHash, timingSafeEqual } from "node:crypto";

const YT = "https://brightan.myjetbrains.com/youtrack";
const QUERY =
  "Board Jobseeker App Delivery: {Current sprint} has: -{Due Date} State: {In Preparation}";

// Hash first so lengths match, then constant-time compare.
const sha = (v) => createHash("sha256").update(String(v ?? "")).digest();
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

  const yt = (path, init = {}) =>
    fetch(YT + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.YOUTRACK_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

  try {
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
      // CSRF: Basic creds are auto-sent cross-site. A JSON content type forces a CORS preflight, which we never allow; also reject foreign Origins.
      if (
        !req.contentType?.startsWith("application/json") ||
        (req.origin && new URL(req.origin).host !== req.host)
      )
        return json(403, { error: "forbidden" });
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
      const tr = await yt(`/api/issues/${m[1]}?fields=customFields(name,$type)`);
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
