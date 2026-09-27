// The deployed fixture-m7 container (tests/fixtures/m7/fixture.mjs), on the internal fixture network only:
//   :8080  the targets (m7*.fixture.fcpi.test), the enhanced provider (zyte.fixture.fcpi.test, POST /v1/extract) and the
//          webhook receiver (hooks.fixture.fcpi.test, POST /receive), told apart by the request's Host
//   127.0.0.1:8082  control, reached only with docker exec: GET /__stats, POST /__reset, POST /__mode?m=<ok|520|521|429|
//          500|401|502|blackhole|malformed>, POST /__version?path=/doc&v=<n>, POST /__hooks/fail?n=<n>,
//          POST /__replay?as=<same|stale|tampered> (the receiver's last delivery sent to it again, changed as named)
// The provider's key is checked by its SHA-256 (a Compose secret); the receiver holds the webhook signing secret itself,
// as a receiver must. A request that came through the M6 fixture proxy is told apart by its peer address, the proxy
// container's, resolved from its fixture name.
import http from "node:http";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { makeState, makeZyte, makeTarget, makeReceiver, stats, reset } from "./fixture.mjs";

const secret = (name) => readFileSync(`/run/secrets/${name}`, "utf8").trim();
const keySha256 = secret("fixture_zyte_sha256").replace(/^sha256:/, "");
if (!/^[0-9a-f]{64}$/.test(keySha256)) throw new Error("fixture_zyte_sha256 is not a SHA-256 hex digest");
const hookSecret = secret("fixture_webhook_secret");
if (hookSecret.length < 32) throw new Error("fixture_webhook_secret is shorter than 32 characters");

const state = makeState();
let proxyAddress = null;
const refreshProxy = () => lookup("proxy.fixture.fcpi.test", { family: 4 }).then((a) => { proxyAddress = a.address; }, () => {});
await refreshProxy();
setInterval(refreshProxy, 60000).unref();
const resolve = async (h) => (await lookup(h, { family: 4 })).address;
const zyte = makeZyte(state, { keySha256, resolve, port: 8080 });
const target = makeTarget(state, { isProxied: (req) => proxyAddress !== null && req.socket.remoteAddress === proxyAddress });
const receiver = makeReceiver(state, { secret: hookSecret });
// One listener: the Host header picks the part.
http.createServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  const part = host === "zyte.fixture.fcpi.test" ? zyte : host === "hooks.fixture.fcpi.test" ? receiver : target;
  part.emit("request", req, res);
}).listen(8080, "0.0.0.0");

// A POST to this container's own listener with the Host given (fetch would not send one).
const post = (headers, body) => new Promise((done) => {
  const q = http.request({ host: "127.0.0.1", port: 8080, method: "POST", path: "/receive", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (r) => {
    const c = [];
    r.on("data", (x) => c.push(x));
    r.on("end", () => { let j = {}; try { j = JSON.parse(Buffer.concat(c).toString("utf8")); } catch { /* not JSON */ } done({ status: r.statusCode, ...j }); });
  });
  q.on("error", (e) => done({ error: e.message }));
  q.end(body);
});
const MODES = new Set(["ok", "520", "521", "429", "500", "401", "502", "blackhole", "malformed"]);
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (o, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.method === "GET" && u.pathname === "/__stats") return json(stats(state));
  if (req.method === "GET" && u.pathname === "/healthz") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (u.pathname === "/__reset") { reset(state); return json({ ok: true }); }
  if (u.pathname === "/__mode" && MODES.has(u.searchParams.get("m"))) { state.mode = u.searchParams.get("m"); return json({ mode: state.mode }); }
  if (u.pathname === "/__version" && /^\/[a-z-]+$/.test(u.searchParams.get("path") ?? "") && /^-?\d{1,4}$/.test(u.searchParams.get("v") ?? "")) {
    state.versions.set(u.searchParams.get("path"), Number(u.searchParams.get("v"))); return json({ versions: Object.fromEntries(state.versions) });
  }
  if (u.pathname === "/__hooks/fail" && /^\d{1,2}$/.test(u.searchParams.get("n") ?? "")) { state.hooks.failNext = Number(u.searchParams.get("n")); return json({ failNext: state.hooks.failNext }); }
  // The receiver's last delivery sent to it again: as it was (a replay within the tolerance, acknowledged as a duplicate),
  // with a timestamp an hour old and its signature recomputed (stale), or with its body changed (tampered).
  if (u.pathname === "/__replay" && state.hooks.last) {
    const as = u.searchParams.get("as");
    const last = state.hooks.last;
    let headers = { ...last.headers }, body = last.body;
    if (as === "stale") {
      headers["x-fcpi-timestamp"] = String(Number(headers["x-fcpi-timestamp"]) - 3600);
      headers["x-fcpi-signature"] = `v1=${createHmac("sha256", hookSecret).update(`${headers["x-fcpi-timestamp"]}.${headers["x-fcpi-event-id"]}.`).update(body).digest("hex")}`;
    } else if (as === "tampered") body = body.replace(/"success":(true|false)/, (m) => (m.endsWith("true") ? '"success":false' : '"success":true'));
    else if (as !== "same") return json({ error: "as must be same, stale or tampered" }, 400);
    const r = await post({ ...headers, host: "hooks.fixture.fcpi.test:8080" }, body);
    return json({ as, eventId: headers["x-fcpi-event-id"], ...r });
  }
  json({ error: "not_found" }, 404);
}).listen(8082, "127.0.0.1");
