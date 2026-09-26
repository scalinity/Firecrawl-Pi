// The JSON Schema subset extraction accepts (FIRECRAWL_PI_SPEC.md §14): what strict Structured Outputs
// can enforce, checked before any money is spent, and a validator for the model's answer.
//   checkSchema: a caller's schema must be an object schema within the size, depth and property limits,
//     built only from the keywords below. A remote or local reference ($ref), a regular expression
//     (pattern) or any keyword not listed is refused by name, so scraped content never meets a schema
//     feature this code does not understand.
//   toStrict: every property becomes required and an optional one nullable, with additionalProperties
//     false, as strict mode requires; a value the page does not hold therefore comes back null, never
//     invented and never silently dropped.
//   validate: the answer against the strict schema, with a path for every error.
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "description", "title", "additionalProperties", "anyOf"]);

export class SchemaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function checkSchema(schema, { maxBytes, maxDepth, maxProperties }) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new SchemaError("SCHEMA_INVALID", "the schema must be a JSON object");
  const size = Buffer.byteLength(JSON.stringify(schema));
  if (size > maxBytes) throw new SchemaError("SCHEMA_TOO_LARGE", `the schema is ${size} bytes; at most ${maxBytes}`);
  let properties = 0;
  const walk = (s, path, depth) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new SchemaError("SCHEMA_INVALID", `${path} must be a schema object`);
    if (depth > maxDepth) throw new SchemaError("SCHEMA_TOO_DEEP", `${path} nests deeper than ${maxDepth} levels`);
    for (const k of Object.keys(s)) {
      if (k === "$ref" || k === "$defs" || k === "definitions") throw new SchemaError("SCHEMA_UNSUPPORTED", `${path}: ${k} is refused; references cannot be resolved safely (spec §14)`);
      if (!KEYWORDS.has(k)) throw new SchemaError("SCHEMA_UNSUPPORTED", `${path}: the keyword '${k}' is not supported`);
    }
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || s.anyOf.length < 1 || s.anyOf.length > 8) throw new SchemaError("SCHEMA_INVALID", `${path}.anyOf must list 1 to 8 schemas`);
      if (s.type !== undefined) throw new SchemaError("SCHEMA_INVALID", `${path}: anyOf and type may not be combined`);
      s.anyOf.forEach((x, i) => walk(x, `${path}.anyOf[${i}]`, depth + 1));
      return;
    }
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.length || types.some((t) => !TYPES.has(t))) throw new SchemaError("SCHEMA_INVALID", `${path}.type must be one or more of ${[...TYPES].join(", ")}`);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > 500 || s.enum.some((v) => v !== null && typeof v === "object"))) {
      throw new SchemaError("SCHEMA_INVALID", `${path}.enum must list 1 to 500 scalar values`);
    }
    for (const k of ["description", "title"]) if (s[k] !== undefined && (typeof s[k] !== "string" || s[k].length > 1000)) throw new SchemaError("SCHEMA_INVALID", `${path}.${k} must be a string of at most 1000 characters`);
    if (types.includes("object")) {
      if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties) || Object.keys(s.properties).length === 0) {
        throw new SchemaError("SCHEMA_INVALID", `${path}: an object schema must name its properties`);
      }
      if (s.additionalProperties !== undefined && s.additionalProperties !== false) throw new SchemaError("SCHEMA_UNSUPPORTED", `${path}: additionalProperties may only be false`);
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string" || !Object.hasOwn(s.properties, r)))) {
        throw new SchemaError("SCHEMA_INVALID", `${path}.required must name properties the schema defines`);
      }
      for (const [name, sub] of Object.entries(s.properties)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name === "__proto__") throw new SchemaError("SCHEMA_INVALID", `${path}: property name '${name.slice(0, 80)}' must be 1-64 of A-Z a-z 0-9 _ . -, and not __proto__`);
        if (++properties > maxProperties) throw new SchemaError("SCHEMA_TOO_LARGE", `the schema defines more than ${maxProperties} properties`);
        walk(sub, `${path}.${name}`, depth + 1);
      }
    } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
      throw new SchemaError("SCHEMA_INVALID", `${path}: properties belong to object schemas`);
    }
    if (types.includes("array")) walk(s.items ?? (() => { throw new SchemaError("SCHEMA_INVALID", `${path}: an array schema must give its items`); })(), `${path}.items`, depth + 1);
    else if (s.items !== undefined) throw new SchemaError("SCHEMA_INVALID", `${path}: items belong to array schemas`);
  };
  const top = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.anyOf !== undefined || top.length !== 1 || top[0] !== "object") throw new SchemaError("SCHEMA_INVALID", "the top level must be a single object schema");
  walk(schema, "$", 1);
  return { bytes: size, properties };
}

const nullable = (s) => {
  if (s.anyOf) return s.anyOf.some((x) => x.type === "null") ? s : { ...s, anyOf: [...s.anyOf, { type: "null" }] };
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes("null")) return s;
  const out = { ...s, type: [...types, "null"] };
  if (out.enum) out.enum = [...out.enum, null];
  return out;
};

// Every property is nullable in the strict form, required ones included: one chunk of a page may not
// hold a value the whole page does, and a strict schema that forbids null there would force the model to
// invent one. Whether a required property was found is judged on the merged result (missingRequired).
export function toStrict(s) {
  if (s.anyOf) return { ...s, anyOf: s.anyOf.map(toStrict) };
  const out = { ...s };
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes("object")) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, nullable(toStrict(v))]));
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  }
  if (types.includes("array")) out.items = toStrict(s.items);
  return out;
}

// The paths of the caller's required properties that are still null (or absent) in `value`.
export function missingRequired(value, s, path = "$") {
  if (!s || s.anyOf || value === null || value === undefined) return [];
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const out = [];
  if (types.includes("object") && typeof value === "object" && !Array.isArray(value)) {
    for (const k of s.required ?? []) if (value[k] === null || value[k] === undefined) out.push(`${path}.${k}`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) out.push(...missingRequired(value[k], sub, `${path}.${k}`));
  }
  if (types.includes("array") && Array.isArray(value)) value.forEach((x, i) => out.push(...missingRequired(x, s.items, `${path}[${i}]`)));
  return out;
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const fits = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number" && Number.isFinite(v));

// Errors of `value` against a strict schema, at most `max` of them, each "path: problem".
export function validate(value, schema, max = 20) {
  const errors = [];
  const walk = (v, s, path) => {
    if (errors.length >= max) return;
    if (s.anyOf) { if (!s.anyOf.some((x) => validate(v, x, 1).length === 0)) errors.push(`${path}: matches none of the allowed shapes`); return; }
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => fits(v, t))) { errors.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(v)}`); return; }
    if (s.enum && !s.enum.some((e) => e === v)) { errors.push(`${path}: not one of the allowed values`); return; }
    if (typeOf(v) === "object") {
      for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties, k)) errors.push(`${path}.${k}: not in the schema`);
      for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) errors.push(`${path}.${k}: missing`);
      for (const [k, sub] of Object.entries(s.properties)) if (Object.hasOwn(v, k)) walk(v[k], sub, `${path}.${k}`);
    }
    if (typeOf(v) === "array") v.forEach((x, i) => walk(x, s.items, `${path}[${i}]`));
  };
  walk(value, schema, "$");
  return errors;
}
