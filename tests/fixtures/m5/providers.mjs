// M5's fixture providers, used by the retrieval service's unit tests and served by the fixture-m5
// container on the internal fixture network:
//   model   an OpenAI-compatible POST /v1/chat/completions. It answers as a deterministic extractor: for
//           each property of the requested schema it looks for "name: value" lines (or "name[]: value" for
//           arrays) in the content it was given and answers null for what is absent, so chunking,
//           provenance and the never-invent rule are tested on real content. A mode in the caller's own
//           prompt ("fcpi-mode=<mode>") selects a failure; usage counts are bytes/4, rounded up.
//   parser  LlamaParse's REST API v2: POST /api/v2/parse/upload, GET /api/v2/parse/{id}?expand=markdown,
//           DELETE /api/v1/files/{id}. A mode comment in the PDF ("%fcpi-parser-mode=<mode>") selects a
//           failure; a page count is read from the PDF's page objects.
//   search  the targets of SearXNG's "fcpi fixture" and "fcpi fixture b" json_engines: GET /search and
//           /search-b ?q=… with results, none ("fcpi-empty"), a 500 ("fcpi-fail"; on /search-b also
//           "fcpi-partial", which makes the pair's answer partial) or a stall past SearXNG's engine timeout
//           ("fcpi-slow").
// GET /__stats on each answers the calls it has seen, so a test can show that a refusal made none.
import { randomUUID } from "node:crypto";

const stats = { model: { calls: 0, modes: {} }, parser: { uploads: 0, polls: 0, deletes: 0, modes: {} }, search: { calls: 0 } };
export const providerStats = () => JSON.parse(JSON.stringify(stats));
export const resetStats = () => { stats.model = { calls: 0, modes: {} }; stats.parser = { uploads: 0, polls: 0, deletes: 0, modes: {} }; stats.search = { calls: 0 }; };
const json = (res, status, body, headers = {}) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json", "content-length": b.length, ...headers }).end(b); };
const readAll = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c))); });
const tokens = (s) => Math.ceil(Buffer.byteLength(s) / 4);

// ---- the model -------------------------------------------------------------------------------------
function valueFor(schema, raw) {
  const types = schema?.anyOf ? schema.anyOf.map((x) => x.type).flat() : [schema?.type].flat();
  if (types.includes("integer") && /^-?\d+$/.test(raw)) return Number(raw);
  if (types.includes("number") && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (types.includes("boolean") && /^(yes|no|true|false)$/i.test(raw)) return /^(yes|true)$/i.test(raw);
  if (types.includes("string")) return raw;
  return null;
}
export function extractFrom(schema, content) {
  const out = {};
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[ _]");
    const types = [sub.type].flat();
    if (types.includes("array")) {
      const vals = [...content.matchAll(new RegExp(`^${esc}\\[\\]:\\s*(.+)$`, "gmi"))].map((m) => valueFor(sub.items, m[1].trim())).filter((v) => v !== null);
      out[name] = vals.length ? vals : null;
    } else if (types.includes("object")) {
      out[name] = null;
    } else {
      const m = content.match(new RegExp(`^${esc}:\\s*(.+)$`, "mi"));
      out[name] = m ? valueFor(sub, m[1].trim()) : null;
    }
  }
  return out;
}
export async function modelHandler(req, res) {
  if (req.method === "GET" && req.url === "/__stats") return json(res, 200, stats.model);
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, { error: { message: "not found" } });
  const body = JSON.parse((await readAll(req)).toString("utf8") || "{}");
  stats.model.calls++;
  const all = (body.messages ?? []).map((m) => m.content).join("\n");
  const mode = (all.match(/fcpi-mode=([a-z0-9-]+)/) ?? [])[1] ?? "ok";
  stats.model.modes[mode] = (stats.model.modes[mode] ?? 0) + 1;
  const last = body.messages?.at(-1)?.content ?? "";
  const repair = /does not match the required JSON schema/.test(last);
  if (mode === "http-401") return json(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
  if (mode === "http-402") return json(res, 402, { error: { message: "Payment required", type: "billing_error" } });
  if (mode === "quota-429") return json(res, 429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } });
  if (mode === "http-429") return json(res, 429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, { "retry-after": "7" });
  if (mode === "http-500") return json(res, 500, { error: { message: "The server had an error", type: "server_error" } });
  if (mode === "http-400") return json(res, 400, { error: { message: "Invalid schema", type: "invalid_request_error" } });
  if (mode === "slow") { await new Promise((r) => setTimeout(r, 90000)); }
  if (mode === "delay") { await new Promise((r) => setTimeout(r, 3000)); }
  const content = (body.messages ?? []).filter((m) => m.role === "user").map((m) => m.content)[0] ?? "";
  const schema = body.response_format?.json_schema?.schema ?? { properties: {} };
  let answer = JSON.stringify(extractFrom(schema, content));
  let finish = "stop", refusal = null;
  if (mode === "invalid-always" || (mode === "invalid-once" && !repair)) answer = "{\"not\": \"the schema\"";
  if (mode === "refuse") { answer = null; refusal = "I can't help with that."; }
  if (mode === "length") { answer = answer.slice(0, 5); finish = "length"; }
  const usage = { prompt_tokens: tokens(JSON.stringify(body.messages)), completion_tokens: tokens(answer ?? refusal), total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  json(res, 200, { id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: answer, refusal }, finish_reason: finish }], ...(mode === "no-usage" ? {} : { usage }) });
}

// ---- the parser --------------------------------------------------------------------------------------
const jobs = new Map();
function partsOf(buf, contentType) {
  const boundary = (contentType.match(/boundary=([^;]+)/) ?? [])[1];
  if (!boundary) return {};
  const out = {};
  const sep = Buffer.from(`--${boundary}`);
  let at = buf.indexOf(sep);
  while (at !== -1) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = buf.subarray(at + sep.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString("latin1");
    const name = (head.match(/name="([^"]+)"/) ?? [])[1];
    if (name) out[name] = part.subarray(headEnd + 4);
    at = next;
  }
  return out;
}
export async function parserHandler(req, res) {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/__stats") return json(res, 200, stats.parser);
  if (!/^Bearer \S+$|^$/.test(req.headers.authorization ?? "")) return json(res, 401, { detail: "Invalid authentication" });
  if (req.method === "POST" && url.pathname === "/api/v2/parse/upload") {
    const parts = partsOf(await readAll(req), req.headers["content-type"] ?? "");
    const file = parts.file ?? Buffer.alloc(0);
    const config = JSON.parse(parts.configuration?.toString("utf8") ?? "{}");
    const mode = (file.toString("latin1").match(/%fcpi-parser-mode=([a-z0-9-]+)/) ?? [])[1] ?? "ok";
    stats.parser.uploads++;
    stats.parser.modes[mode] = (stats.parser.modes[mode] ?? 0) + 1;
    if (mode === "http-401") return json(res, 401, { detail: "Invalid API key" });
    if (mode === "http-402") return json(res, 402, { detail: "Insufficient credits" });
    if (mode === "http-500") return json(res, 500, { detail: "Internal error" });
    if (mode === "no-job-id") return json(res, 200, { status: "PENDING" });
    const pages = Math.max(1, (file.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length);
    const scanned = /\/Subtype \/Image/.test(file.toString("latin1")) && !/BT /.test(file.toString("latin1"));
    const id = `pjb-${randomUUID()}`, fileId = `file-${randomUUID()}`;
    // "ignore-max-pages" parses every page whatever the configuration asked, as a provider counting pages
    // differently would.
    jobs.set(id, { mode, pages: mode === "ignore-max-pages" ? pages : Math.min(pages, config.page_ranges?.max_pages ?? pages), scanned, fileId, polls: 0, tier: config.tier, maxPages: config.page_ranges?.max_pages ?? null });
    return json(res, 200, { id, status: "PENDING" });
  }
  let m;
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/v2\/parse\/([A-Za-z0-9_-]+)$/))) {
    const j = jobs.get(m[1]);
    stats.parser.polls++;
    if (!j) return json(res, 404, { detail: "Job not found" });
    j.polls++;
    if (j.mode === "never-finishes" || j.polls < 2) return json(res, 200, { job: { id: m[1], status: "RUNNING", file_id: j.fileId } });
    if (j.mode === "job-fails") return json(res, 200, { job: { id: m[1], status: "FAILED", error_message: "fixture failure", file_id: j.fileId } });
    const pages = Array.from({ length: j.pages }, (_, i) => ({ page_number: i + 1,
      markdown: j.mode === "empty" ? "" : j.scanned ? `# FCPI SCAN 42\n\nText recognised from the image of page ${i + 1} (fixture OCR, ${j.tier}).` : `# Page ${i + 1}\n\nFixture parse of page ${i + 1} (${j.tier}).` }));
    return json(res, 200, { job: { id: m[1], status: "COMPLETED", file_id: j.fileId }, markdown: { pages } });
  }
  if (req.method === "DELETE" && (m = url.pathname.match(/^\/api\/v1\/files\/([A-Za-z0-9_-]+)$/))) { stats.parser.deletes++; res.writeHead(204).end(); return; }
  json(res, 404, { detail: "not found" });
}

// ---- the search engine behind SearXNG's "fcpi fixture" -----------------------------------------------
export async function searchHandler(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__stats") return json(res, 200, stats.search);
  // /search-b is the second fixture engine: it also fails on "fcpi-partial", so the first engine's answer
  // is a partial result.
  if (url.pathname !== "/search" && url.pathname !== "/search-b") return json(res, 404, {});
  stats.search.calls++;
  const q = url.searchParams.get("q") ?? "";
  if (/fcpi-fail/.test(q) || (url.pathname === "/search-b" && /fcpi-partial/.test(q))) return json(res, 500, { error: "fixture engine failure" });
  if (/fcpi-slow/.test(q)) { await new Promise((r) => setTimeout(r, 15000)); }
  if (/fcpi-empty/.test(q)) return json(res, 200, { results: [] });
  const results = Array.from({ length: 7 }, (_, i) => ({ url: `http://m5.fixture.fcpi.test:8080/extract/result-${i + 1}.html`, title: `Fixture result ${i + 1} for ${q.slice(0, 40)}`, content: `Fixture result ${i + 1}.` }));
  json(res, 200, { results });
}
