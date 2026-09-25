// Minimal JSON Schema validator for the keywords the M0 schema uses.
// Any keyword outside SUPPORTED throws, so a constraint can never be ignored silently.
const SUPPORTED = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description",
  "type", "required", "properties", "additionalProperties", "minProperties",
  "items", "minItems", "enum", "const", "pattern", "minLength", "minimum", "anyOf",
]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeOk = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number");

export function validate(schema, data) {
  const errors = [];
  const resolveRef = (ref) => {
    if (!ref.startsWith("#/$defs/")) throw new Error(`unsupported $ref ${ref}`);
    const s = schema.$defs?.[ref.slice(8)];
    if (!s) throw new Error(`unresolved $ref ${ref}`);
    return s;
  };
  const walk = (s, v, path) => {
    for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Error(`unsupported schema keyword '${k}' at ${path}`);
    if (s.$ref) return walk(resolveRef(s.$ref), v, path);
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => typeOk(v, t))) { errors.push(`${path}: expected ${ts.join("|")}, got ${typeOf(v)}`); return; }
    }
    if ("const" in s && v !== s.const) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
    if (typeof v === "string") {
      if (s.minLength != null && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    }
    if (typeof v === "number" && s.minimum != null && v < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${path}[${i}]`));
    }
    if (typeOf(v) === "object") {
      for (const r of s.required ?? []) if (!(r in v)) errors.push(`${path}: missing required '${r}'`);
      if (s.minProperties != null && Object.keys(v).length < s.minProperties) errors.push(`${path}: fewer than ${s.minProperties} properties`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties && k in s.properties) walk(s.properties[k], x, `${path}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${path}: unexpected property '${k}'`);
        else if (typeof s.additionalProperties === "object") walk(s.additionalProperties, x, `${path}.${k}`);
      }
    }
    if (s.anyOf) {
      // Each branch is validated alone; only $defs is shared with the root.
      const branchErrors = s.anyOf.map((b) => validate({ ...b, $defs: schema.$defs }, v));
      if (!branchErrors.some((e) => e.length === 0)) errors.push(`${path}: matches no anyOf branch (${branchErrors.map((e) => e[0]).join(" / ")})`);
    }
  };
  walk(schema, data, "$");
  return errors;
}
