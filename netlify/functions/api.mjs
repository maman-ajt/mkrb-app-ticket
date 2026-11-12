import { handle } from "../../server/api.js";

// Netlify serves only static files, so /api/* runs here. Env vars come from the Netlify UI.
export default async (request) => {
  const url = new URL(request.url);
  const body = request.method === "POST" ? (await request.text()).slice(0, 2048) : "";
  const { status, body: out, headers } = await handle(
    {
      method: request.method,
      pathname: url.pathname,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      origin: request.headers.get("origin"),
      userToken: request.headers.get("x-youtrack-token"),
      host: url.host,
      body,
    },
    process.env,
  );
  return new Response(typeof out === "string" ? out : JSON.stringify(out), {
    status,
    headers: { "Content-Type": typeof out === "string" ? "text/plain" : "application/json", ...headers },
  });
};

export const config = { path: "/api/*" };
