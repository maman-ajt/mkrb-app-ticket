import react from "@vitejs/plugin-react";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vite";

const YT = "https://brightan.myjetbrains.com/youtrack";
const QUERY =
  "Board Jobseeker App Delivery: {Current sprint} has: -{Due Date} State: {In Preparation}";

// Server-side proxy: token + login never reach the browser.
function ticketApi(env) {
  const auth =
    "Basic " +
    Buffer.from(`${env.APP_USERNAME}:${env.APP_PASSWORD}`).toString("base64");
  const yt = (path, init = {}) =>
    fetch(YT + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.YOUTRACK_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  const send = (res, code, body) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  // Hash first so lengths match, then constant-time compare.
  const sha = (v) =>
    createHash("sha256")
      .update(String(v ?? ""))
      .digest();
  const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b));
  const handler = async (req, res, next) => {
    if (!sameSecret(req.headers.authorization, auth)) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="tickets"');
      return res.end("Auth required");
    }
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/api/tickets") {
        const r = await yt(
          `/api/issues?query=${encodeURIComponent(QUERY)}&$top=200&fields=idReadable,summary,customFields(name,value(name))`,
        );
        const data = await r.json();
        if (!r.ok) return send(res, r.status, data);
        return send(
          res,
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
      const m = url.pathname.match(/^\/api\/tickets\/([\w-]+)\/due$/);
      if (req.method === "POST" && m) {
        // CSRF: Basic creds are auto-sent cross-site. A JSON content type forces a CORS preflight, which we never allow; also reject foreign Origins.
        const origin = req.headers.origin;
        if (
          !req.headers["content-type"]?.startsWith("application/json") ||
          (origin && new URL(origin).host !== req.headers.host)
        )
          return send(res, 403, { error: "forbidden" });
        let raw = "";
        for await (const c of req) {
          raw += c;
          if (raw.length > 1024) return send(res, 413, { error: "too large" });
        }
        let date;
        try {
          ({ date } = JSON.parse(raw)); // YYYY-MM-DD
        } catch {
          return send(res, 400, { error: "bad json" });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
          return send(res, 400, { error: "bad date" });
        // YouTrack rejects customFields without $type, and it depends on the field kind: resolve it from the issue first.
        const tr = await yt(
          `/api/issues/${m[1]}?fields=customFields(name,$type)`,
        );
        if (!tr.ok) return send(res, tr.status, await tr.json());
        const type = (await tr.json()).customFields?.find(
          (f) => f.name === "Due Date",
        )?.$type;
        if (!type)
          return send(res, 400, {
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
        return send(
          res,
          r.ok ? 200 : r.status,
          r.ok ? { ok: true } : await r.json(),
        );
      }
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
    next();
  };
  return {
    name: "ticket-api",
    configureServer(s) {
      s.middlewares.use(handler);
    },
    configurePreviewServer(s) {
      s.middlewares.use(handler);
    },
  };
}

// Read .env only: vite's loadEnv lets shell variables (e.g. a YOUTRACK_TOKEN in ~/.zshrc) override the file.
const env = parseEnv(readFileSync(new URL("./.env", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react(), ticketApi(env)],
});
