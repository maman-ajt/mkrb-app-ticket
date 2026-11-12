import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vite";
import { handle } from "./server/api.js";

// .env wins over shell variables (a stray YOUTRACK_TOKEN in ~/.zshrc must not override it).
// No .env (e.g. CI build) is fine: the API runs from the Netlify function, not from here.
const envFile = new URL("./.env", import.meta.url);
const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

// Dev/preview adapter for the shared API handler.
function ticketApi() {
  const middleware = async (req, res, next) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 2048) break; // handler answers 413
    }
    const { status, body: out, headers } = await handle(
      {
        method: req.method,
        pathname: url.pathname,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        origin: req.headers.origin,
        host: req.headers.host,
        body,
      },
      env,
    );
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    res.setHeader("Content-Type", typeof out === "string" ? "text/plain" : "application/json");
    res.end(typeof out === "string" ? out : JSON.stringify(out));
  };
  return {
    name: "ticket-api",
    configureServer(s) {
      s.middlewares.use(middleware);
    },
    configurePreviewServer(s) {
      s.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), ticketApi()],
});
