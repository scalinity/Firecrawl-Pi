#!/usr/bin/env node
// SI6's verifier (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §26, CLAUDE.md §25-§26): every result recomputed from raw evidence.
// Before the cutover: the API build of record (clean tree, every step run, HEAD's patch series), the native chain against that
// very image, the rollout naming that image and series, and the lock builder run on synthetic cutover evidence built from HEAD's
// pins, with a negative control for each refusal that guards the real run and a check that earlier milestones' lock fields
// survive. After the cutover, each step's record (retained images, the API transfer, the image build, the cutover, the
// functional check, the host snapshots, the redaction scan) is checked when it exists and reported NOT_RUN until then: the
// cutover waits on the owner's launch authorization. Writes evidence/search-intelligence/SI6/verification.json.
//   node scripts/si6/verify.mjs
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT, sha256, repoState } from "../m0/lib.mjs";

const E = "evidence/search-intelligence/SI6", RAW = `${E}/raw`;
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const repo = repoState(), series = JSON.parse(read("patches/series.json"));
const results = [];
const record = (id, expected, ok, actual, evidence, extra = {}) => results.push({ id, utc: new Date().toISOString(), expected, actual, state: ok === null ? "NOT_RUN" : ok ? "PASS" : "FAIL", evidence, ...extra });

// ---- before the cutover -------------------------------------------------------------------------------------------------
const log = read(`${RAW}/api-build.log`);
const apiId = log.match(/^id=(sha256:[0-9a-f]{64}) os=linux arch=arm64 /m)?.[1] ?? null;
const built = log.match(/^repository_commit=([0-9a-f]{40}) code_dirty=(true|false)$/m);
record("api-build-of-record", "a clean tree, no_cache=1, HEAD's series hash, an arm64 image id", !!(apiId && built?.[2] === "false" && /^no_cache=1$/m.test(log) && log.includes(`FCPI_PATCH_SERIES_SHA256=${series.series_sha256}`)),
  { image: apiId, built_from: built?.[1] ?? null, series: series.series_sha256 }, `${RAW}/api-build.log`, { patch_series_sha256: series.series_sha256, image_digest: apiId });
const chain = read(`${RAW}/native-chain-release-image.txt`);
const chainJson = JSON.parse(chain.slice(chain.indexOf("\n{", chain.indexOf("### checks")) + 1, chain.lastIndexOf("}") + 1));
const chainImage = chain.match(/^image=fcpi\/firecrawl-api:m2 id=(sha256:[0-9a-f]{64}) /m)?.[1];
record("native-chain-on-release-image", "every check PASS against the build of record's image, HEAD's series", chainImage === apiId && chainJson.failed === 0 && chainJson.passed === chainJson.checks.length && chain.includes(`patch_series_sha256=${series.series_sha256}`) && /code_dirty=false/.test(chain),
  { image: chainImage, passed: chainJson.passed, failed: chainJson.failed }, `${RAW}/native-chain-release-image.txt`);
const rollout = read(`${E}/ROLLOUT.md`);
record("rollout-names-the-build", "ROLLOUT.md names the image and series of record", !!apiId && rollout.includes(apiId.slice(7, 19)) && rollout.includes(series.series_sha256.slice(0, 8)),
  { image: apiId?.slice(7, 19), series: series.series_sha256.slice(0, 8) }, `${E}/ROLLOUT.md`);

// The lock builder on synthetic evidence: HEAD's own pins stand in for the release's, so every chain check it makes can hold.
const compose = git("show", "HEAD:deploy/compose.yaml");
const pin = (r) => compose.match(new RegExp(`${r}@(sha256:[0-9a-f]{64})`))?.[1];
const pins = { "firecrawl-core": pin("fcpi/firecrawl-api"), "retrieval-service": pin("fcpi/retrieval"), "access-gateway": pin("fcpi/access-gateway"), "mcp-gateway": pin("fcpi/mcp-gateway") };
const head = git("rev-parse", "HEAD").trim();
const synth = (mutate = {}) => {
  const d = mkdtempSync(join(tmpdir(), "fcpi-si6-lock-"));
  const files = {
    "api-build.log": log.replace(/^id=sha256:[0-9a-f]{64} /m, `id=${pins["firecrawl-core"]} `),
    "api-push.txt": `pi_image=${pins["firecrawl-core"]} arm64\n### end\n`,
    "image-build.txt": ["### images", ...[["retrieval", "retrieval-service"], ["access-gateway", "access-gateway"], ["mcp-gateway", "mcp-gateway"]].flatMap(([t, s]) => [`fcpi/${t}:si6 id=${pins[s]} os=linux arch=arm64 size=1 user=node`, `fcpi/${t}:si6 FCPI_SOURCE_COMMIT=${head}`]), "end", ""].join("\n"),
    "cutover.txt": [`### meta`, `utc=2026-10-18T00:00:00Z deployed_commit=${head} mode=cutover services=firecrawl-core retrieval-service access-gateway mcp-gateway`, "### state",
      ...Object.entries(pins).map(([s, id]) => `${s} image=${id} status=running health=healthy`), "end_marker=reached utc=2026-10-18T00:05:00Z", ""].join("\n"),
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), mutate[f] ? mutate[f](t) : t);
  return d;
};
const runLock = (dir, out = null) => spawnSync(process.execPath, [resolve(ROOT, "scripts/si6/build-lock.mjs")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FCPI_SI6_RAW: dir, ...(out ? { FCPI_SI6_LOCK_OUT: out } : {}) } });
if (Object.values(pins).every(Boolean)) {
  const d = synth(), out = join(d, "lock.json"), r = runLock(d, out);
  let kept = false, detail = r.stderr.trim().split("\n").at(-1) ?? "";
  if (r.status === 0) {
    const was = JSON.parse(git("show", "HEAD:deploy/versions.lock.json")), now = JSON.parse(readFileSync(out, "utf8"));
    const providerFieldsKept = Object.entries(was.providers.providers ?? {}).every(([k, v]) => Object.keys(v).every((f) => f in now.providers.providers[k]));
    const searchKept = ["engines", "fallback_engines", "live_engine_hosts", "per_hour", "cache_seconds", "deadline_ms", "engine_routes"].every((f) => JSON.stringify(was.providers.search?.[f]) === JSON.stringify(now.providers.search?.[f]));
    const noNullApi = Object.values(now.providers.providers).every((v) => v.api !== null);
    const paidCaps = Object.keys(now.providers.budget_policy.paid_caps).length === Object.values(JSON.parse(git("show", "HEAD:deploy/policies/budget.json")).categories).filter((c) => c.paid).length;
    kept = providerFieldsKept && searchKept && noNullApi && paidCaps;
    detail = { providerFieldsKept, searchKept, noNullApi, paidCapsRecomputed: paidCaps };
  }
  record("build-lock-synthetic", "resolves from consistent evidence and keeps every earlier milestone's lock field", r.status === 0 && kept, { exit: r.status, detail }, "synthetic, from HEAD's pins");
  rmSync(d, { recursive: true, force: true });
  // Each guard of the real run, shown able to refuse.
  for (const [id, mutate, want] of [
    ["unhealthy", { "cutover.txt": (t) => t.replace("retrieval-service image=", "retrieval-service image=").replace(/(retrieval-service image=\S+ status=running health=)healthy/, "$1starting") }, /running and healthy/],
    ["another-commit", { "cutover.txt": (t) => t.replace(`deployed_commit=${head}`, `deployed_commit=${"0".repeat(40)}`) }, /a cutover of HEAD/],
    ["no-end-marker", { "cutover.txt": (t) => t.replace(/^end_marker=reached .*$/m, "end_marker=failed reason=compose_exit_1") }, /end marker/],
    ["partial-image-build", { "image-build.txt": (t) => t.replace(/^end$/m, "") }, /completed image build/],
    ["dirty-build", { "api-build.log": (t) => t.replace(/code_dirty=false/, "code_dirty=true") }, /build of record/],
    ["pin-not-running", { "cutover.txt": (t) => t.replace(/^(mcp-gateway image=)sha256:[0-9a-f]{64}/m, `$1sha256:${"f".repeat(64)}`) }, /compose pin for mcp-gateway/]]) {
    const dd = synth(mutate), rr = runLock(dd);
    record(`build-lock-refuses-${id}`, "refuses, naming the failed guard", rr.status !== 0 && want.test(rr.stderr), { exit: rr.status, message: rr.stderr.trim().split("\n").find((l) => /cannot resolve/.test(l))?.slice(0, 200) ?? null }, "synthetic negative control");
    rmSync(dd, { recursive: true, force: true });
  }
} else record("build-lock-synthetic", "HEAD's compose pins every SI6 service", false, pins, "deploy/compose.yaml");

// ---- after the cutover (each step's record, when it exists) -------------------------------------------------------------
const after = (id, file, expected, check) => {
  const p = `${RAW}/${file}`;
  if (!existsSync(resolve(ROOT, p))) return record(id, expected, null, "the cutover waits on the owner's launch authorization", p);
  const t = read(p), r = check(t);
  record(id, expected, r === true, r === true ? "as expected" : r, p);
};
after("retained-images", "retained.txt", "every running image tagged retained-5d91186 before any tag moves", (t) => (t.match(/^retained fcpi\/\S+ sha256:[0-9a-f]{64}$/gm) ?? []).length === 5 || "not five retained images");
after("api-on-pi", "api-push.txt", "the Pi holds the API build of record", (t) => t.includes(`pi_image=${apiId} arm64`) || "the Pi does not report the logged image");
after("service-images", "image-build.txt", "three :si6 images built from the staged release candidate", (t) => (/^end$/m.test(t) && (t.match(/^fcpi\/\S+:si6 id=sha256:[0-9a-f]{64} os=linux arch=arm64 /gm) ?? []).length === 3) || "an incomplete build");
after("cutover", "cutover.txt", "the end marker reached, every service running and healthy, the release recorded", (t) => (/^end_marker=reached /m.test(t) && (t.match(/ status=running health=healthy$/gm) ?? []).length === 4 && /^### release$/m.test(t)) || "not reached");
after("functional", "verify-functional.txt", "fcpi verify functional passes after the cutover", (t) => (/\bPASS\b/.test(t) && !/\bFAIL\b/.test(t)) || "a functional check failed");
after("host-snapshots", "snapshot-after.txt", "the host snapshot taken after the cutover", () => existsSync(resolve(ROOT, `${RAW}/snapshot-before.txt`)) || "no snapshot before");
after("redaction", "redaction.json", "the redaction scan passes over the release's evidence", (t) => JSON.parse(t).result === "PASS" || "the scan did not pass");

const out = { schema: "fcpi.si6-verification/v1", utc: new Date().toISOString(), source_sha: repo.repository_sha, code_dirty: repo.code_dirty, patch_series_sha256: series.series_sha256,
  config_sha256: { budget: sha256(read("deploy/policies/budget.json")), egress: sha256(read("deploy/policies/egress.json")), capabilities: sha256(read("deploy/policies/capabilities.json")), compose: sha256(read("deploy/compose.yaml")) },
  summary: Object.fromEntries(["PASS", "FAIL", "NOT_RUN"].map((s) => [s, results.filter((r) => r.state === s).length])), results };
writeFileSync(resolve(ROOT, `${E}/verification.json`), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.summary), results.filter((r) => r.state === "FAIL").map((r) => r.id).join(" "));
process.exit(out.summary.FAIL ? 1 : 0);
