// The MCP tools (FIRECRAWL_PI_SPEC.md §16.3), derived from the capability manifest rather than restated:
// each tool names a gateway route, its input schema is generated from that route's body (the same
// fields, types, bounds and enums the gateway validates), and a call becomes one request to that route.
// The gateway stays the one policy boundary: it authenticates the caller's token again, checks the
// scope, admits, records receipts and binds every job lookup to the caller's principal.
// Payloads are bounded (spec §16.3: 256 KiB by default, pagination rather than silent truncation):
// status pages carry as many documents as fit and say where to continue; a single document or scrape
// that does not fit is cut field by field, and the answer says which fields and how much.

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const IDEM = "^[A-Za-z0-9._:-]{8,128}$";
const fieldsOf = (m, body) => ({ ...(body.extends ? m.fieldsets[body.extends] : {}), ...body.fields });

// One manifest field as JSON Schema. A type the manifest adds later and this does not know stops
// startup, so a tool never advertises a looser schema than the gateway enforces.
// ctx.objects: whether this tool's route takes object formats (M5: the json format, on scrape alone, as the
// gateway refuses it elsewhere).
function fieldSchema(spec, m, ctx = {}) {
  switch (spec.type) {
    case "boolean": return { type: "boolean" };
    case "const": return { const: spec.value };
    case "integer": return { type: "integer", minimum: spec.min, maximum: spec.max, ...(spec.default !== undefined ? { default: spec.default } : {}) };
    case "number": return { type: "number", ...(spec.exclusiveMin ? { exclusiveMinimum: spec.min } : { minimum: spec.min }), maximum: spec.max };
    case "enum": return { type: "string", enum: [...spec.values] };
    case "string": return { type: "string", maxLength: spec.maxLength };
    case "strings": case "regexes": return { type: "array", items: { type: "string", minLength: 1, maxLength: spec.maxLength }, maxItems: spec.maxItems };
    case "url": return { type: "string", minLength: 1, maxLength: 2048 };
    case "urls": return { type: "array", items: { type: "string", minLength: 1, maxLength: 2048 }, minItems: 1, maxItems: ctx.maxUrls ?? m.limits.batch.maxUrls };
    case "formats": {
      const objects = ctx.objects ? Object.entries(m.formats.objects ?? {}) : [];
      const names = m.formats.allowed.filter((n) => !(m.formats.objects ?? {})[n]);
      const items = objects.length ? { anyOf: [{ type: "string", enum: names }, ...objects.map(([name, opts]) => objectSchema(opts, m, { type: { const: name } }, ctx, ["type"]))] } : { type: "string", enum: names };
      return { type: "array", items, minItems: 1, maxItems: 10 };
    }
    case "schema": return { type: "object", description: "A JSON Schema for the data to extract: an object schema built from type, properties, required, items, enum, anyOf, description and title; no $ref, no pattern." };
    case "object": return objectSchema(fieldsOf(m, { extends: spec.fieldset, fields: {} }), m, {}, {});
    // M7: the action subset, one object schema per action (click's "all", which the gateway accepts only as false, is
    // left out), and a job's webhook.
    case "actions": {
      const opt = { milliseconds: { type: "integer", minimum: 1, maximum: spec.maxWaitMs }, selector: { type: "string", minLength: 1, maxLength: 256 },
        boolean: { type: "boolean" }, direction: { type: "string", enum: ["up", "down"] } };
      const items = Object.entries(spec.subset).map(([type, opts]) => ({ type: "object", required: ["type"], additionalProperties: false,
        properties: { type: { const: type }, ...Object.fromEntries(Object.entries(opts).filter(([k]) => !(type === "click" && k === "all")).map(([k, t]) => [k, opt[t]])) } }));
      return { type: "array", items: { anyOf: items }, maxItems: spec.maxItems,
        description: `At most ${spec.maxItems} actions and ${spec.maxWaitMs} ms of waiting (a selector wait counts ${spec.selectorWaitMs} ms); each screenshot comes back as the address of an authorized artifact.` };
    }
    case "webhook": return { type: "object", required: ["url"], additionalProperties: false, description: "An approved destination for the job's signed events; see the capabilities' limits.webhooks.",
      properties: { url: { type: "string", minLength: 1, maxLength: 2048 }, metadata: { type: "object" }, events: { type: "array", minItems: 1, items: { type: "string", enum: [...spec.events] } } } };
    default: throw new Error(`capability manifest: field type ${spec.type} has no MCP schema`);
  }
}
function objectSchema(fields, m, extra = {}, ctx = {}, extraRequired = []) {
  const properties = {}, required = [...extraRequired];
  for (const [k, spec] of Object.entries(fields)) {
    if (spec.type === "replaced") continue;          // set by the gateway (the submission marker), never by a caller
    properties[k] = fieldSchema(spec, m, ctx);
    if (spec.required) required.push(k);
  }
  Object.assign(properties, extra);
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const idOnly = () => ({ type: "object", properties: { id: { type: "string", pattern: UUID, description: "The job id a start tool returned." } }, required: ["id"], additionalProperties: false });
const idemKey = { type: "string", pattern: IDEM, description: "Your own key for this submission (8-128 of A-Z a-z 0-9 . _ : -). Retrying with the same key and the same arguments returns the same job; the same key with other arguments is refused." };

// The input schema and the REST request of one tool, by the kind of route it names.
function kindOf(route) {
  if (route.id === "platform.job") return "receipt";
  if (route.id === "platform.status") return "capabilities";
  if (route.mode === "sync") return "sync";
  if (route.mode === "async") return "submit";
  if (/^(crawl|batch)\.status$/.test(route.id)) return "status";
  if (route.id === "extract.status") return "extractStatus";
  if (/^(crawl|batch)\.cancel$/.test(route.id)) return "cancel";
  throw new Error(`capability manifest: route ${route.id} has no MCP mapping`);
}
function inputSchema(kind, route, m) {
  const L = m.mcp.limits;
  switch (kind) {
    case "sync": return objectSchema(fieldsOf(m, m.bodies[route.body]), m, {}, { objects: route.id === "scrape" });
    case "submit": return objectSchema(fieldsOf(m, m.bodies[route.body]), m, { idempotencyKey: idemKey }, { maxUrls: route.kind === "extract" ? m.limits.extract.maxUrls : m.limits.batch.maxUrls });
    case "status": return { type: "object", properties: { id: idOnly().properties.id,
      skip: { type: "integer", minimum: 0, maximum: 1000000000, default: 0, description: "How many documents to skip: 0, or the nextSkip of the previous answer." },
      limit: { type: "integer", minimum: 1, maximum: L.statusPageMax, default: L.statusPageDefault, description: "At most this many documents in this answer (fewer when the payload limit is reached)." } },
      required: ["id"], additionalProperties: false };
    case "cancel": case "receipt": case "extractStatus": return idOnly();
    case "capabilities": return { type: "object", properties: {}, additionalProperties: false };
  }
}
const fill = (path, id) => path.replace("{id}", encodeURIComponent(id));
function request(kind, route, args, m) {
  switch (kind) {
    case "sync": return { method: "POST", path: route.path, body: args };
    case "submit": { const { idempotencyKey, ...body } = args; return { method: "POST", path: route.path, body, idemKey: idempotencyKey }; }
    case "status": return { method: "GET", path: `${fill(route.path, args.id)}?skip=${args.skip ?? 0}&limit=${args.limit ?? m.mcp.limits.statusPageDefault}` };
    case "cancel": return { method: "DELETE", path: fill(route.path, args.id) };
    case "receipt": case "extractStatus": return { method: "GET", path: fill(route.path, args.id) };
    case "capabilities": return { method: "GET", path: route.path };
  }
}

// ---- bounding ---------------------------------------------------------------------------------------
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
// Cuts the longest of a document's string fields (and its links list) until the whole payload fits,
// recording each cut field's original and returned size. Returns the cuts, or null when nothing was cut.
const CUTTABLE = ["rawHtml", "html", "markdown", "summary"];
export function fitDocument(payload, doc, budget) {
  const cuts = {};
  for (let guard = 0; guard < 16 && bytes(payload) > budget; guard++) {
    const over = bytes(payload) - budget;
    const field = CUTTABLE.filter((f) => typeof doc[f] === "string" && doc[f].length > 0).sort((a, b) => Buffer.byteLength(doc[b]) - Buffer.byteLength(doc[a]))[0];
    if (field) {
      const before = Buffer.byteLength(doc[field]);
      cuts[field] ??= { originalBytes: before };
      // Characters are at most 4 bytes and JSON escaping at most 6 per character: cut generously, then re-measure.
      const keep = Math.max(0, doc[field].length - Math.ceil(over) - 256);
      doc[field] = doc[field].slice(0, keep);
      cuts[field].returnedBytes = Buffer.byteLength(doc[field]);
      continue;
    }
    if (Array.isArray(doc.links) && doc.links.length) {
      cuts.links ??= { originalCount: doc.links.length };
      doc.links = doc.links.slice(0, Math.floor(doc.links.length / 2));
      cuts.links.returnedCount = doc.links.length;
      continue;
    }
    break;
  }
  return Object.keys(cuts).length ? cuts : null;
}

// ---- answers ----------------------------------------------------------------------------------------
const errorOf = (r) => ({ error: { httpStatus: r.status, code: r.json?.code ?? null, message: r.json?.error ?? `The gateway answered ${r.status}.`, ...(r.json?.id ? { id: r.json.id } : {}), ...(r.json?.receipt ? { receipt: r.json.receipt } : {}), ...(r.headers?.["retry-after"] ? { retryAfterSeconds: Number(r.headers["retry-after"]) } : {}) } });

function shape(kind, tool, r, args, m, omitted) {
  const budget = m.mcp.limits.toolTextMaxBytes;
  const ok = r.status >= 200 && r.status < 300 && r.json && r.json.success !== false;
  if (!ok) {
    const e = errorOf(r);
    if (kind === "submit") e.error.idempotencyKey = args.idempotencyKey ?? null;
    // A page too large for the core can abort it, and the gateway then answers 502: an unchanged retry
    // aborts it again, restarting the core under every job in flight.
    if (tool.route === "scrape" && r.status === 502) e.error.advice = "The core stopped answering while it processed this page. If this recurs for the same URL, do not retry it unchanged: very large pages can stop the core. Ask for formats [\"markdown\"] alone, or leave the page out.";
    return { isError: true, payload: e };
  }
  const b = r.json;
  switch (kind) {
    case "sync": {
      if (tool.route === "map") {
        const payload = { links: b.links ?? [] };
        const total = payload.links.length;
        // Measured with the marker in place, so the marker cannot push the answer past the limit.
        while (bytes(payload) > budget && payload.links.length) {
          payload.links = payload.links.slice(0, Math.floor(payload.links.length / 2));
          payload.truncated = { links: { originalCount: total, returnedCount: payload.links.length }, note: "The link list exceeded the tool payload limit; give a smaller limit or a search term." };
        }
        return { payload };
      }
      if (tool.route === "search") {
        // Results in order until the payload limit; a single result too large alone is cut field by field.
        const payload = { data: b.data ?? {}, ...(b.warning ? { warning: b.warning } : {}) };
        const web = Array.isArray(payload.data.web) ? payload.data.web : [];
        const total = web.length;
        while (bytes(payload) > budget && payload.data.web?.length > 1) {
          payload.data.web = payload.data.web.slice(0, Math.floor(payload.data.web.length / 2));
          payload.truncated = { results: { originalCount: total, returnedCount: payload.data.web.length }, note: "The results exceeded the tool payload limit; ask for fewer results or fewer scrape formats." };
        }
        if (bytes(payload) > budget && payload.data.web?.length === 1) payload.truncated = { ...payload.truncated, fields: fitDocument(payload, payload.data.web[0], budget - 512) };
        return { payload };
      }
      const payload = { data: b.data ?? null, ...(b.fcpi ? { fcpi: b.fcpi } : {}) };
      const cuts = payload.data && typeof payload.data === "object" ? fitDocument(payload, payload.data, budget - 512) : null;
      if (cuts) payload.truncated = { fields: cuts, note: "The page exceeded the tool payload limit, so the fields named here were cut. Ask for fewer formats (markdown alone is smallest), or scrape it as a batch job and read it page by page." };
      return { payload };
    }
    case "submit": return { payload: { id: b.id, results: b.url ?? null, idempotencyKey: args.idempotencyKey ?? null, ...(b.invalidURLs ? { invalidURLs: b.invalidURLs } : {}),
      next: `Poll it with ${{ "crawl.submit": "firecrawl_check_crawl_status", "batch.submit": "firecrawl_batch_status", "extract.submit": "firecrawl_extract_status" }[tool.route]} and this id; its receipt is firecrawl_get_result.` } };
    case "status": {
      const skip = args.skip ?? 0, data = Array.isArray(b.data) ? b.data : [];
      const payload = { id: args.id, status: b.status, completed: b.completed ?? 0, total: b.total ?? 0, creditsUsed: b.creditsUsed ?? 0, expiresAt: b.expiresAt ?? null,
        ...(b.error ? { error: b.error } : {}), skip, returned: 0, nextSkip: null, data: [] };
      // Each document is measured once against a running total (the page is never re-serialized per
      // document), and a document too large alone is cut in place: the parsed answer is this call's own,
      // so no copy of it is made.
      let used = bytes(payload);
      for (const doc of data) {
        const size = bytes(doc) + 1;
        if (used + size <= budget - 256) { payload.data.push(doc); used += size; continue; }
        if (payload.data.length) break;
        // The first document alone does not fit: it is returned cut, and the answer says so.
        payload.data.push(doc);
        payload.truncated = { document: skip, fields: fitDocument(payload, doc, budget - 512), note: "This document exceeded the tool payload limit, so the fields named here were cut; the whole document is at the results address with limit=1." };
        break;
      }
      payload.returned = payload.data.length;
      // A running job's next poll resumes after what this one returned, even when every current document
      // fitted: later documents arrive past them. A finished job has more only while documents remain.
      const running = !["completed", "failed", "cancelled"].includes(b.status);
      const more = running || payload.returned < data.length || !!b.next;
      payload.nextSkip = more ? skip + payload.returned : null;
      return { payload };
    }
    case "cancel": return { payload: { id: args.id, status: b.status ?? "cancelled" } };
    case "extractStatus": {
      // The extracted data is bounded by the adapter (192 KiB); the per-unit detail is cut first if needed.
      const { success, ...rest } = b;
      const payload = { id: args.id, ...rest };
      if (bytes(payload) > budget && payload.fcpi?.units) {
        const n = payload.fcpi.units.length;
        payload.fcpi = { ...payload.fcpi, units: payload.fcpi.units.filter((u) => !u.ok).slice(0, 20), unitsCut: { originalCount: n } };
      }
      return { payload };
    }
    case "receipt": return { payload: b.job };
    case "capabilities": {
      const { success, ...status } = b;
      return { payload: { ...status, mcp: { tools: m.mcp.tools.map((t) => t.name).sort(), omitted } } };
    }
  }
}

// The tool set, sorted by name so the catalog's order never depends on the manifest's.
export function makeTools(m) {
  const omitted = (m.mcp.omitted ?? []).map((o) => ({ name: o.name, reason: m.not_enabled.find((r) => r.method === o.method && r.path === o.path).reason }));
  return [...m.mcp.tools].sort((a, b) => (a.name < b.name ? -1 : 1)).map((t) => {
    const route = m.routes.find((r) => r.id === t.route);
    const kind = kindOf(route);
    return {
      name: t.name, route, kind, long: kind === "sync" || kind === "submit",
      config: { title: t.title, description: t.description, inputSchema: inputSchema(kind, route, m), annotations: { title: t.title, ...t.annotations } },
      request: (args) => request(kind, route, args, m),
      shape: (r, args) => shape(kind, t, r, args, m, omitted),
    };
  });
}
