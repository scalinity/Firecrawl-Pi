// Documentation activation (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §13): whether Context7 and Ref join the search. An
// ordered policy that favors recall; its record says what decided it.
//   1. documentation "off" suppresses both providers (conflicting hints were already refused by validation).
//   2. "required", explicit library hints or an explicit request for documentation activates both at once.
//   3. Strong deterministic signals activate at once: code or a stack trace with an implementation question, API symbols, a
//      version beside a library, configuration keys, migration or troubleshooting language about a technology, technical phrases.
//   4. Medium technical cues (a technology named with weaker context) activate too: Jev's low score may not suppress them.
//   5. Only weak cues (a product-like name, a "how do I set up" form) ask Jev one question within its 800 ms; 0.20 or more
//      activates, less suppresses. Jev missing, refused, invalid or late: possibly technical requests activate.
//   6. No cue at all: suppressed deterministically, without asking anyone.
// General engines run whatever this decides; documentation helping never means web search stops.
import { VERSIONS } from "./contracts.mjs";

// Names that mean a technology outright, and names that are also ordinary words (they count only beside technical context);
// each word is in one list only.
const LIBRARIES = new Set(("vue angular svelte next.js nextjs nuxt remix astro django fastapi laravel nestjs tokio axum actix serde numpy scipy pytorch torch " +
  "tensorflow keras jax mlx mlx-lm transformers langchain llamaindex openai anthropic kubernetes k8s docker terraform ansible postgres postgresql mysql sqlite redis kafka rabbitmq nginx " +
  "node.js nodejs deno typescript javascript python golang kotlin java dotnet .net prisma drizzle tailwind tailwindcss vite webpack esbuild babel jest vitest playwright puppeteer " +
  "selenium httpx aiohttp axios graphql grpc protobuf ollama vllm llama.cpp gguf huggingface firecrawl supabase firebase aws gcp azure s3 cloudflare vercel netlify github gitlab npm " +
  "pnpm yarn cargo maven gradle zod three.js d3 opencv sklearn scikit-learn xgboost lightgbm polars duckdb dbt mongodb elasticsearch opensearch sqlalchemy pydantic " +
  "websocket oauth jwt mcp searxng chromium webassembly wasm cuda coreml onnx triton jupyter numba cython uvicorn gunicorn systemd zsh powershell linux macos ios android " +
  "tauri flutter swiftui jetpack unreal godot").split(/\s+/));
const COMMON_WORD_LIBRARIES = new Set("react swift rust go spring express node requests celery bun spark lambda helm git flask hugo jekyll ruby rails pip compose make pandas bash metal unity expo electron dart airflow".split(" "));
const TECH_WORDS = new Set(("api apis sdk cli library libraries package packages module modules function functions method methods class classes config configure configured configuring " +
  "configuration settings setting install installation installing timeout timeouts error errors exception exceptions bug bugs deprecated deprecation migrate migrating migration " +
  "upgrade upgrading version versions release releases endpoint endpoints parameter parameters param params argument arguments flag flags option options hook hooks component " +
  "components plugin plugins middleware database schema deploy deployment build compile compiler runtime async await thread threads stream streaming socket sockets http https json " +
  "yaml toml env environment variable variables container image cluster server client request response header headers token tokens auth authentication cache caching query queries " +
  "index indexes quantization quantize inference model models gpu cpu memory kernel driver framework frameworks docs documentation reference syntax regex compile typescript import " +
  "export decorator generics interface struct enum trait macro performance latency throughput benchmark benchmarks optimize optimization profiling profiler").split(/\s+/));
const EXPLICIT = /\b(docs?|documentation|api reference|reference docs?|official docs?|manual|man page|readme|changelog|release notes)\b/i;
const MIGRATION = /\b(migrat(e|ion|ing)|upgrad(e|ing)|breaking changes?|deprecat(ed|ion)|troubleshoot(ing)?|not working|doesn'?t work|fails?|failing|crash(es|ing)?|regression)\b/i;
const CONFIG = /\b(config(ure|ured|uration)?|settings?|env(ironment)? var(iable)?s?|\.ya?ml|\.toml|\.ini|\.env|flags?|options?)\b/i;
const PHRASES = /\b(api reference|framework documentation|rest api|graphql api|sdk|cli|endpoint|webhook|middleware|type definitions?|stack trace|error code)\b/i;
const QUESTION = /\b(how|why|what|where|when|fix|resolve|solve|works?|use|using|implement|handle|avoid|prevent)\b/i;
const CODE = /```|^\s{4}\S|\bTraceback \(most recent call last\)|^\s*at [\w.$<>]+ \(.+:\d+:\d+\)|Exception in thread|panicked at|\bE\d{4}\b|\berror\[E\d+\]|\bSegmentation fault\b/m;
const SYMBOL = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(|\b\w+::\w+|\b[A-Za-z_$][\w$]*\(\)|@[a-z0-9-]+\/[a-z0-9._-]+|\bimport\s+[\w{]|\bfrom\s+[\w.]+\s+import\b|\brequire\(|#include\b|(^|\s)--[a-z][\w-]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b|\b[a-z]+[A-Z][a-zA-Z]+\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
// A version beside a technology: dotted (3.5, 2.11.162) or v-prefixed (v18); a bare number is a count, not a version.
const VERSION = /\b(v?\d+(\.\d+){1,3}|v\d+)([-.]?(alpha|beta|rc|preview)\.?\d*)?\b/i;
// A dotted identifier of three labels (os.path.join, torch.nn.functional), never a hostname (www.bbc.co.uk, docs.example.org).
const DOTTED = /\b([a-z_]+)\.([a-z_]+)\.([a-z_]+)\b/g;
const SUFFIX = new Set("com org net io co uk de fr jp edu gov dev app ai us au ca info biz me tv".split(" "));
const dottedSymbol = (text) => [...text.matchAll(DOTTED)].some((m) => m[1] !== "www" && !SUFFIX.has(m[3]));
const VERB_USE = /\b(react|go|express|spring|swift|rust|node|spark|make|compose|bun)\s+(to|with|for|of|in|on|at|over|away|ahead|back|up|out|forward)\b/gi;
const WEAK_HOWTO = /\bhow (do|can|to|should) (i |we |you )?(use|set ?up|setup|integrate|connect|run|enable|disable|create|add|remove|update|install|configure)\b/i;
const WEAK_NAME = /\b[A-Z][a-z]+[A-Z]\w*\b|\b[A-Z]{2,6}\b/;

// The deterministic analysis: { decision: "positive"|"unresolved"|"weak"|"none", signals }.
export function analyzeQuery(query, intelligence = {}) {
  const text = String(query);
  const words = text.toLowerCase().replace(VERB_USE, " ").split(/[^\p{L}\p{N}.+#-]+/u).filter(Boolean).map((w) => w.replace(/[.]+$/, ""));
  const libs = words.filter((w) => LIBRARIES.has(w));
  const commonLibs = words.filter((w) => COMMON_WORD_LIBRARIES.has(w) && !LIBRARIES.has(w));
  const tech = words.filter((w) => TECH_WORDS.has(w));
  const technology = libs.length > 0 || (commonLibs.length > 0 && (tech.length > 0 || VERSION.test(text)));
  const signals = [];
  if (EXPLICIT.test(text)) signals.push("explicit_docs_request");
  if (CODE.test(text) && QUESTION.test(text)) signals.push("code_or_trace");
  if (SYMBOL.test(text) || dottedSymbol(text)) signals.push("api_symbol");
  if (technology && VERSION.test(text.replace(/\b(19|20)\d{2}\b/g, " "))) signals.push("library_version");
  if (CONFIG.test(text) && (technology || tech.length >= 2)) signals.push("configuration");
  if (MIGRATION.test(text) && technology) signals.push("migration_or_troubleshooting");
  if (PHRASES.test(text)) signals.push("technical_phrase");
  if (intelligence.libraries?.length) signals.push("explicit_libraries");
  if (signals.length) return { decision: "positive", signals };
  // A technology with technical vocabulary, or technical vocabulary alone, cannot be ruled out by a low score.
  if ((technology && tech.length >= 1) || tech.length >= 2) return { decision: "unresolved", signals: [technology ? "technology_with_vocabulary" : "technical_vocabulary"] };
  // A bare technology name, a common-word library, one technical word or a setup question: Jev's question decides.
  if (technology || commonLibs.length || tech.length || WEAK_HOWTO.test(text) || WEAK_NAME.test(text)) return { decision: "weak", signals: [technology ? "technology_named" : "weak_cue"] };
  return { decision: "none", signals: [] };
}

export function makeDocumentation({ decisions = null, log = () => {} }) {
  return {
    async activate(request, { signal, deadlineAt, selection, decisionSubject }) {
      const base = { classifierVersion: VERSIONS.classifier };
      const mode = request.intelligence.documentation;
      if (mode === "off") return { ...base, active: false, reason: "explicit_off", uncertainty: null, signals: [] };
      if (mode === "required") return { ...base, active: true, reason: "explicit_required", uncertainty: null, signals: ["required"] };
      if (request.intelligence.libraries?.length) return { ...base, active: true, reason: "explicit_libraries", uncertainty: null, signals: ["explicit_libraries"] };
      const a = analyzeQuery(request.originalQuery, request.intelligence);
      if (a.decision === "positive") return { ...base, active: true, reason: a.signals.includes("explicit_docs_request") ? "explicit_docs_request" : "deterministic_signal", uncertainty: null, signals: a.signals };
      if (a.decision === "unresolved") return { ...base, active: true, reason: "unresolved_technical_signal", uncertainty: null, signals: a.signals };
      if (a.decision === "none") return { ...base, active: false, reason: "nontechnical", uncertainty: null, signals: [] };
      // Weak cues only: Jev's one question decides; without it, a possibly technical request activates.
      if (!decisions || !decisionSubject) return { ...base, active: true, reason: "classifier_unavailable_possibly_technical", uncertainty: null, signals: a.signals };
      const r = await decisions.classifyDocs(request, { signal, deadlineAt, selection, decisionSubject });
      if (!r.ok) { log({ event: "si_docs_classifier_fallback", reason: r.reason }); return { ...base, active: true, reason: `classifier_${r.reason}_possibly_technical`, uncertainty: null, signals: a.signals, jev: { status: "failed", reason: r.reason } }; }
      return { ...base, active: r.probability >= 0.2, reason: r.probability >= 0.2 ? "classifier_positive" : "classifier_negative", uncertainty: r.probability, signals: a.signals,
        jev: { status: "ok", probability: r.probability, model: r.model }, usage: r.usage };
    },
  };
}
