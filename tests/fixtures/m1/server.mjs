// M1 controlled static fixture server. Serves files under ./site read-only, GET/HEAD
// only, and logs one JSON line per request so a test can prove which requests arrived.
// Node built-ins only; run as a non-root user on an internal project network.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "site");
const PORT = Number(process.env.FIXTURE_PORT ?? 8080);

const server = createServer(async (req, res) => {
  let path = null;
  try { path = normalize(decodeURIComponent(new URL(req.url, "http://fixture").pathname)); } catch { /* malformed escape */ }
  let status = 200;
  let body = null;
  if (path === null) status = 400;
  else if (req.method !== "GET" && req.method !== "HEAD") status = 405;
  else if (!path.endsWith(".html") || path.includes("..")) status = 404;
  else body = await readFile(join(ROOT, path)).catch(() => null);
  if (status === 200 && body === null) status = 404;
  console.log(JSON.stringify({ utc: new Date().toISOString(), method: req.method, path, status, from: req.socket.remoteAddress, ua: req.headers["user-agent"] ?? null }));
  if (status !== 200) {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${status}\n`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
});

server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ utc: new Date().toISOString(), listening: PORT })));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
