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

function checkFormats(v, manifest) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) throw bad("'formats' must be a non-empty array of at most 10 formats");
  const out = [];
  for (const f of v) {
    const type = typeof f === "string" ? f : (f && typeof f === "object" && !Array.isArray(f) ? f.type : undefined);
    if (typeof type !== "string") throw bad("each format must be a string or an object with a type");
    if (manifest.formats.refused[type]) throw new RequestError(400, "UNSUPPORTED_OPTION", `format '${type}' is not supported by this deployment: ${manifest.formats.refused[type]}.`, { option: `formats.${type}` });
    if (!manifest.formats.allowed.includes(type)) throw bad(`unknown format '${type}'`);
    if (typeof f === "object" && Object.keys(f).some((k) => k !== "type")) throw bad(`format '${type}' takes no options`);
    if (!out.includes(type)) out.push(type);
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
    case "enum": if (!spec.values.includes(v)) throw bad(`'${where}' must be one of ${spec.values.join(", ")}`); return v;
    case "string": if (typeof v !== "string" || v.length > spec.maxLength) throw bad(`'${where}' must be a string of at most ${spec.maxLength} characters`); return v;
    case "strings": case "regexes": {
      if (!Array.isArray(v) || v.length > spec.maxItems || v.some((s) => typeof s !== "string" || s.length === 0 || s.length > spec.maxLength)) throw bad(`'${where}' must be an array of at most ${spec.maxItems} strings of 1-${spec.maxLength} characters`);
      if (spec.type === "regexes") for (const s of v) { try { new RegExp(s); } catch (e) { throw bad(`'${where}' holds an invalid regular expression: ${e.message}`); } }
      return v;
    }
    case "url": { const why = checkUrl(v); if (why) throw bad(`'${where}' ${why}`); return v.trim(); }
    case "urls": if (!Array.isArray(v)) throw bad(`'${where}' must be an array of URLs`); return v; // each URL is checked by validateBody
    case "formats": return checkFormats(v, manifest);
    case "object": return checkObject(v, fieldsOf(manifest, { extends: spec.fieldset, fields: {} }), manifest, where);
    default: throw new Error(`capability manifest: unknown field type ${spec.type}`);
  }
}

const fieldsOf = (manifest, body) => ({ ...(body.extends ? manifest.fieldsets[body.extends] : {}), ...body.fields });

function checkObject(obj, fields, manifest, path = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw bad(`${path ? `'${path}'` : "the body"} must be a JSON object`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const where = path ? `${path}.${k}` : k;
    const spec = fields[k];
    if (k.startsWith("__") && !spec) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}' is an internal upstream option and is not accepted.`, { option: where });
    if (!spec && manifest.refused[k]) throw new RequestError(400, "UNSUPPORTED_OPTION", `'${where}' is not supported by this deployment: ${manifest.refused[k]}.`, { option: where });
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
  const body = checkObject(raw, fieldsOf(manifest, manifest.bodies[kind]), manifest);
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
