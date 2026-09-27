// The deployed fixture-m6 container (tests/fixtures/m6/fixture.mjs), on the internal fixture network only:
//   :8080  the targets, under m6*.fixture.fcpi.test and searchr.fixture.fcpi.test
//   :8081  the residential proxy, as proxy.fixture.fcpi.test (its credential's SHA-256 from a Compose secret)
//   127.0.0.1:8082  control, reached only with docker exec: GET /__stats, POST /__reset, POST /__mode?m=<ok|407|402|429|503|refuse|blackhole>
import http from "node:http";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { makeState, makeProxy, makeTarget, stats, reset } from "./fixture.mjs";

const state = makeState();
const credentialSha256 = readFileSync("/run/secrets/fixture_proxy_sha256", "utf8").trim().replace(/^sha256:/, "");
if (!/^[0-9a-f]{64}$/.test(credentialSha256)) throw new Error("fixture_proxy_sha256 is not a SHA-256 hex digest");
// Targets are reached by name through Docker's resolver on the fixture network; the network has no route out.
makeProxy(state, { credentialSha256, resolve: async (h) => (await lookup(h, { family: 4 })).address }).listen(8081, "0.0.0.0");
makeTarget(state).listen(8080, "0.0.0.0");
const MODES = new Set(["ok", "407", "402", "429", "503", "refuse", "blackhole"]);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.method === "GET" && u.pathname === "/__stats") return json(stats(state));
  if (req.method === "POST" && u.pathname === "/__reset") { reset(state); return json({ ok: true }); }
  if (req.method === "POST" && u.pathname === "/__mode" && MODES.has(u.searchParams.get("m"))) { state.mode = u.searchParams.get("m"); return json({ mode: state.mode }); }
  if (req.method === "GET" && u.pathname === "/healthz") return json({ ok: true });
  res.writeHead(404).end();
}).listen(8082, "127.0.0.1");
