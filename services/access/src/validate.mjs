// Request validation against the capability manifest (FIRECRAWL_PI_SPEC.md §16.1): only the options
// the manifest lists pass, each checked against its type and bounds; an option the manifest refuses
// gets a precise UNSUPPORTED_OPTION error naming it and why, before any work begins; anything else is
// an unrecognized key, as upstream's strict schemas treat it. The result is the normalized body the
// gateway forwards: only accepted keys, the platform's defaults applied, `origin` replaced.
import { createHash } from "node:crypto";

export class RequestError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (msg) => new RequestError(400, "BAD_REQUEST", msg);
// A manifest entry named by client input: own properties only, so "constructor" or "toString" is an
// unknown name rather than an inherited function.
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);

// A target URL: http(s), no userinfo, a host with a top-level domain of two or more letters (as
// upstream's URL schema requires), at most 2 KiB. Where it may resolve is the retrieval service's
// decision (SSRF, fixture exception, Cloud denylist); the gateway only refuses malformed input.
export function checkUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "must be an http(s) URL of at most 2048 characters";
  let u;
  try { u = new URL(raw.trim()); } catch { return "is not a valid URL"; }
  if (!["http:", "https:"].includes(u.protocol)) return "must use http or https";
  if (u.username || u.password) return "must not carry credentials";
  if (!/\.[a-z0-9-]{2,}$/i.test(u.hostname.replace(/\.$/, "")) && !/^\[.*\]$/.test(u.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return "must name a host with a top-level domain";
  return null;
}

// A format is its name, or an object naming it with the options the manifest lists for it (M5: the json
// format's schema and prompt); an object format is passed on as its validated object.
function checkFormats(v, manifest) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) throw bad("'formats' must be a non-empty array of at most 10 formats");
  const out = [];
  for (const f of v) {
    const type = typeof f === "string" ? f : (f && typeof f === "object" && !Array.isArray(f) ? f.type : undefined);
    if (typeof type !== "string") throw bad("each format must be a string or an object with a type");
    const why = own(manifest.formats.refused, type);
    if (why) throw new RequestError(400, "UNSUPPORTED_OPTION", `format '${type}' is not supported by this deployment: ${why}.`, { option: `formats.${type}` });
    if (!manifest.formats.allowed.includes(type)) throw bad(`unknown format '${type}'`);
    const opts = own(manifest.formats.objects ?? {}, type);
    if (out.some((x) => (typeof x === "string" ? x : x.type) === type)) continue;
    if (opts) {
      const { type: _t, ...rest } = typeof f === "object" ? f : {};
      const checked = checkObject(rest, opts, manifest, `formats.${type}`);
      if (type === "json" && ((checked.model !== undefined) !== (checked.reasoningEffort !== undefined))) {
        throw bad("json model and reasoningEffort must be supplied together");
      }
      out.push({ type, ...checked });
      continue;
    }
    if (typeof f === "object" && Object.keys(f).some((k) => k !== "type")) throw bad(`format '${type}' takes no options`);
    out.push(type);
  }
  return out;
}

function checkField(name, spec, v, manifest, path) {
  const where = path ? `${path}.${name}` : name;
  switch (spec.type) {
    case "boolean": if (typeof v !== "boolean") throw bad(`'${where}' must be a boolean`); return v;
    case "const": if (v !== spec.value) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}' may only be ${JSON.stringify(spec.value)} in this deployment.`, { option: where }); return v;
    case "integer": case "number": {
      if (typeof v !== "number" || !Number.isFinite(v) || (spec.type === "integer" && !Number.isInteger(v))) throw bad(`'${where}' must be ${spec.type === "integer" ? "an integer" : "a number"}`);
      if (v < spec.min || v > spec.max || (spec.exclusiveMin && v === spec.min)) throw bad(`'${where}' must be ${spec.exclusiveMin ? "above" : "at least"} ${spec.min} and at most ${spec.max}`);
      return v;
    }
    case "enum":
      if (typeof v === "string" && own(spec.refused, v)) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}: ${v}' is not supported by this deployment: ${own(spec.refused, v)}.`, { option: `${where}.${v}` });
      if (!spec.values.includes(v)) throw bad(`'${where}' must be one of ${spec.values.join(", ")}`);
      return v;
    case "string": {
      if (typeof v !== "string" || v.length > spec.maxLength) throw bad(`'${where}' must be a string of at most ${spec.maxLength} characters`);
      // A minimum counts the visible text, so blank padding is no name.
      if (spec.minLength && v.trim().length < spec.minLength) throw bad(`'${where}' must hold at least ${spec.minLength} non-blank character${spec.minLength > 1 ? "s" : ""}`);
      return v;
    }
    case "strings": case "regexes": {
      if (!Array.isArray(v) || v.length > spec.maxItems || v.some((s) => typeof s !== "string" || s.length === 0 || s.length > spec.maxLength)) throw bad(`'${where}' must be an array of at most ${spec.maxItems} strings of 1-${spec.maxLength} characters`);
      if (spec.type === "regexes") for (const s of v) { try { new RegExp(s); } catch (e) { throw bad(`'${where}' holds an invalid regular expression: ${e.message}`); } }
      return v;
    }
    case "url": { const why = checkUrl(v); if (why) throw bad(`'${where}' ${why}`); return v.trim(); }
    // A JSON Schema for extraction: an object within the body's own size cap here; its keywords, depth and
    // property count are checked by the retrieval service's extraction adapter, which owns that subset.
    case "schema": {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`'${where}' must be a JSON Schema object`);
      if (Buffer.byteLength(JSON.stringify(v)) > 16384) throw bad(`'${where}' must be at most 16384 bytes`);
      return v;
    }
    case "urls": if (!Array.isArray(v)) throw bad(`'${where}' must be an array of URLs`); return v; // each URL is checked by validateBody
    // Search intelligence (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §9.1): a UTC instant (ISO 8601 ending in Z), and a bounded
    // list of objects each checked against its fieldset.
    case "instant":
      // An instant that exists: Date.parse rolls 2026-02-30 over to March and reads T24:00 as the next day, which the core's
      // schema refuses, so the instant must read back as written.
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19)) throw bad(`'${where}' must be an ISO-8601 UTC instant ending in Z`);
      return v;
    case "objects":
      if (!Array.isArray(v) || v.length > spec.maxItems) throw bad(`'${where}' must be an array of at most ${spec.maxItems} objects`);
      return v.map((o, i) => checkObject(o, fieldsOf(manifest, { extends: spec.fieldset, fields: {} }), manifest, `${where}[${i}]`));
    case "actions": return checkActions(v, spec, where);
    case "webhook": return checkWebhook(v, spec, where);
    case "formats": return checkFormats(v, manifest);
    case "object": return checkObject(v, fieldsOf(manifest, { extends: spec.fieldset, fields: {} }), manifest, where);
    default: throw new Error(`capability manifest: unknown field type ${spec.type}`);
  }
}

const fieldsOf = (manifest, body) => ({ ...(body.extends ? manifest.fieldsets[body.extends] : {}), ...body.fields });

// M7: page actions, held to the manifest's subset (spec §12): each action's type and options are named there, and an
// action outside it is refused by name before any work begins. Waits add up to at most spec.maxWaitMs, a selector wait
// counting spec.selectorWaitMs. The retrieval service checks the list again.
const unsupported = (option, msg) => new RequestError(400, "UNSUPPORTED_OPTION", msg, { option });
function checkActions(v, spec, where) {
  if (!Array.isArray(v)) throw bad(`'${where}' must be an array of actions`);
  if (v.length > spec.maxItems) throw unsupported(where, `'${where}' may hold at most ${spec.maxItems} actions in this deployment.`);
  let waited = 0;
  return v.map((a, i) => {
    const at = `${where}[${i}]`;
    if (!a || typeof a !== "object" || Array.isArray(a) || typeof a.type !== "string") throw bad(`'${at}' must be an object with a type`);
    const opts = own(spec.subset, a.type);
    if (!opts) throw unsupported(`${where}.${a.type}`, `action '${a.type}' is not supported by this deployment: ${own(spec.refused, a.type) ?? `the subset is ${Object.keys(spec.subset).join(", ")}`}.`);
    for (const k of Object.keys(a)) {
      if (k === "type") continue;
      if (!Object.hasOwn(opts, k)) throw unsupported(`${at}.${k}`, `'${at}.${k}' is not supported by this deployment: ${own(spec.refused, `${a.type}.${k}`) ?? `action '${a.type}' takes ${Object.keys(opts).join(", ") || "no options"}`}.`);
      if (k === "all" && a.all === true) throw unsupported(`${at}.all`, `'${at}.all' is not supported by this deployment: ${own(spec.refused, "click.all")}.`);
    }
    const out = { type: a.type };
    for (const [k, t] of Object.entries(opts)) {
      if (a[k] === undefined) continue;
      if (t === "selector" && (typeof a[k] !== "string" || !a[k] || a[k].length > 256)) throw bad(`'${at}.${k}' must be a CSS selector of 1-256 characters`);
      if (t === "boolean" && typeof a[k] !== "boolean") throw bad(`'${at}.${k}' must be a boolean`);
      if (t === "direction" && !["up", "down"].includes(a[k])) throw bad(`'${at}.${k}' must be up or down`);
      if (t === "milliseconds" && (!Number.isInteger(a[k]) || a[k] < 1 || a[k] > spec.maxWaitMs)) throw bad(`'${at}.${k}' must be an integer from 1 to ${spec.maxWaitMs}`);
      if (k !== "all") out[k] = a[k];
    }
    if (a.type === "wait") {
      if ((out.milliseconds === undefined) === (out.selector === undefined)) throw bad(`'${at}': a wait takes milliseconds or a selector, not both`);
      waited += out.milliseconds ?? spec.selectorWaitMs;
    }
    if (a.type === "click" && out.selector === undefined) throw bad(`'${at}.selector' is required`);
    if (waited > spec.maxWaitMs) throw unsupported(where, `the actions wait ${waited} ms in all; at most ${spec.maxWaitMs} ms is offered (a selector wait counts ${spec.selectorWaitMs} ms).`);
    return out;
  });
}

// M7: a job's webhook (spec §31.3): the destination (which the retrieval service must approve before the job is
// accepted), the caller's own metadata, returned in every event, and the events wanted. Custom headers are not sent:
// every delivery is signed instead.
function checkWebhook(v, spec, where) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`'${where}' must be an object with a url`);
  for (const k of Object.keys(v)) {
    if (!["url", "metadata", "events"].includes(k)) throw unsupported(`${where}.${k}`, `'${where}.${k}' is not supported by this deployment: ${own(spec.refused, k) ?? "a webhook takes url, metadata and events"}.`);
  }
  if (typeof v.url !== "string" || v.url.length > 2048) throw bad(`'${where}.url' must be a URL of at most 2048 characters`);
  const out = { url: v.url };
  if (v.metadata !== undefined) {
    if (!v.metadata || typeof v.metadata !== "object" || Array.isArray(v.metadata) || Buffer.byteLength(JSON.stringify(v.metadata)) > spec.maxMetadataBytes) throw bad(`'${where}.metadata' must be an object of at most ${spec.maxMetadataBytes} bytes`);
    out.metadata = v.metadata;
  }
  if (v.events !== undefined) {
    if (!Array.isArray(v.events) || v.events.length === 0 || v.events.some((e) => typeof e !== "string")) throw bad(`'${where}.events' must be a non-empty array`);
    for (const e of v.events) if (!spec.events.includes(e)) throw unsupported(`${where}.events.${e}`, `webhook event '${e}' is not supported by this deployment: ${own(spec.refused, `events.${e}`) ?? `the events are ${spec.events.join(", ")}`}.`);
    out.events = [...new Set(v.events)];
  }
  return out;
}

function checkObject(obj, fields, manifest, path = "", refused = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw bad(`${path ? `'${path}'` : "the body"} must be a JSON object`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const where = path ? `${path}.${k}` : k;
    const spec = own(fields, k);
    if (k.startsWith("__") && !spec) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}' is an internal upstream option and is not accepted.`, { option: where });
    const why = !spec ? (own(refused, k) ?? own(manifest.refused, k)) : undefined;
    if (why) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}' is not supported by this deployment: ${why}.`, { option: where });
    if (!spec) throw bad(`Unrecognized key in body: '${where}'`);
    if (spec.type === "replaced" || v === undefined) continue;
    out[k] = checkField(k, spec, v, manifest, path);
  }
  for (const [k, spec] of Object.entries(fields)) {
    if (spec.required && !(k in out)) throw bad(`'${path ? `${path}.` : ""}${k}' is required`);
    if (spec.default !== undefined && !(k in out)) out[k] = spec.default;
  }
  return out;
}

// Validates one route's body. Returns { body, units, invalidURLs }: units are the page units the
// job may consume (spec §23.1's queue-depth measure).
export function validateBody(kind, raw, manifest) {
  const body = checkObject(raw, fieldsOf(manifest, manifest.bodies[kind]), manifest, "", manifest.bodies[kind].refused ?? {});
  // Search (spec §5.3, §9.1): one domain list at a time, as the pinned core requires, refused here before any work; and the
  // search intelligence options' cross-field rules, so conflicting instructions are refused rather than silently dropped.
  if (kind === "search") {
    if (body.includeDomains?.length && body.excludeDomains?.length) throw bad("includeDomains and excludeDomains cannot both be given");
    const si = body.searchIntelligence;
    if (si?.documentation === "off" && (si.libraries?.length || si.programmingLanguage !== undefined)) throw bad("'searchIntelligence.libraries' and 'programmingLanguage' need documentation other than off");
    if (si?.publishedAfter && si?.publishedBefore && !(Date.parse(si.publishedAfter) < Date.parse(si.publishedBefore))) throw bad("'searchIntelligence.publishedAfter' must precede 'publishedBefore'");
  }
  // The json format runs through the gateway's extraction on /v2/scrape alone; anywhere else it would reach
  // the core's own model path, which this deployment does not enable (spec §14). M7: a screenshot is stored as an
  // owner-bound artifact by the /v2/scrape path alone, so it too is offered there only.
  for (const name of manifest.formats.scrapeOnly ?? ["json"]) {
    const at = [body.formats, body.scrapeOptions?.formats].some((fs) => Array.isArray(fs) && fs.some((f) => (typeof f === "object" ? f.type : f) === name));
    if (at && kind !== "scrape") throw new RequestError(400, "UNSUPPORTED_OPTION", name === "json" ? "format 'json' is offered on /v2/scrape; for many pages, use /v2/extract." : `format '${name}' is offered on /v2/scrape only.`, { option: `formats.${name}` });
  }
  // The json format's path (scrape, then extract) stores no captures, so one scrape asks for json or for screenshots and
  // actions, never both: nothing is dropped and no capture leaves unstored (review W2).
  if (kind === "scrape") {
    const types = (body.formats ?? []).map((f) => (typeof f === "object" ? f.type : f));
    if (types.includes("json") && (types.includes("screenshot") || (body.actions ?? []).length > 0)) {
      throw new RequestError(400, "UNSUPPORTED_OPTION", "format 'json' is not offered with screenshots or actions in one scrape; ask for them in separate requests.", { option: "formats.json" });
    }
  }
  if (kind === "batch") {
    const L = manifest.limits.batch;
    if (!Array.isArray(raw.urls) || raw.urls.length === 0) throw bad("'urls' must be a non-empty array");
    if (raw.urls.length > L.maxUrls) throw bad(`'urls' may hold at most ${L.maxUrls} URLs`);
    const valid = [], invalid = [];
    for (const u of raw.urls) (checkUrl(u) ? invalid : valid).push(typeof u === "string" ? u.trim() : u);
    if (invalid.length && body.ignoreInvalidURLs === false) throw bad(`invalid URLs: ${invalid.map(String).slice(0, 5).join(", ")}`);
    const unique = [...new Set(valid)];
    if (!unique.length) throw bad("No valid URLs provided");
    body.urls = unique;
    delete body.ignoreInvalidURLs;
    return { body, units: unique.length, invalidURLs: invalid.map(String) };
  }
  if (kind === "crawl") return { body, units: body.limit, invalidURLs: [] };
  // M5: an extraction reads the URLs it is given and nothing else (spec §14): a wildcard, upstream's way of
  // asking for discovery, is refused by name; the rest are checked as a batch's are.
  if (kind === "extract") {
    const L = manifest.limits.extract;
    if (!Array.isArray(raw.urls) || raw.urls.length === 0) throw bad("'urls' must be a non-empty array");
    if (raw.urls.length > L.maxUrls) throw bad(`'urls' may hold at most ${L.maxUrls} URLs`);
    if (raw.urls.some((u) => typeof u === "string" && /\/\*/.test(u))) {
      throw new RequestError(400, "UNSUPPORTED_OPTION", "wildcard URLs ask for discovery, which is not offered: extraction reads only the URLs given (spec §14).", { option: "urls.*" });
    }
    const valid = [], invalid = [];
    for (const u of raw.urls) (checkUrl(u) ? invalid : valid).push(typeof u === "string" ? u.trim() : u);
    if (invalid.length && body.ignoreInvalidURLs !== true) throw bad(`invalid URLs: ${invalid.map(String).slice(0, 5).join(", ")}`);
    const unique = [...new Set(valid)];
    if (!unique.length) throw bad("No valid URLs provided");
    body.urls = unique;
    delete body.ignoreInvalidURLs;
    delete body.showSources; // sources are always returned
    return { body, units: unique.length, invalidURLs: invalid.map(String) };
  }
  return { body, units: 1, invalidURLs: [] };
}

// Canonical JSON (keys sorted at every level) and its SHA-256, so an idempotent retry is recognised
// whatever order its keys arrive in.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const requestHash = (kind, body) => createHash("sha256").update(`${kind}\n${canonical(body)}`).digest("hex");
