# Firecrawl Pi Platform — Agent Instructions

These instructions are the execution contract for coding and operations agents working on the Firecrawl Pi Platform.

The project is **personal infrastructure**, but it is expected to be engineered to a high standard. Optimize for practical capability, retrieval quality, reliability, maintainability, and strong agent utility. Do not burden the project with unnecessary enterprise governance or compliance machinery, but do not use “personal project” as an excuse for fragile infrastructure.

---

## 1. Mission

Build the system defined by the two canonical project documents:

- `FIRECRAWL_PI_SPEC.md`
- `FIRECRAWL_PI_MILESTONES.md`

The objective is not merely to run Firecrawl OSS. The objective is to make the Raspberry Pi 5 act as a dependable, always-on, Firecrawl-class web-acquisition backend for AI agents, with:

- strong routine web retrieval;
- bounded anti-bot resilience;
- useful Firecrawl Cloud-like utility where reasonably reproducible;
- private REST access;
- modern stateless MCP access;
- durable jobs and persistence;
- reliable recovery;
- stable operation on an ARM64 Raspberry Pi 5 with 8 GB RAM;
- low recurring cost;
- and **no practical dependence on Firecrawl Cloud quota** for the supported paths.

Preserve that vision throughout implementation.

---

## 2. Source of Truth

Before implementing anything, read the relevant portions of both canonical documents.

### Architecture authority

`FIRECRAWL_PI_SPEC.md` governs:

- system architecture;
- version and protocol baselines;
- component selection;
- retrieval behavior;
- security boundaries;
- provider strategy;
- persistence;
- resource budgets;
- networking;
- MCP design;
- cost controls;
- verification philosophy;
- and system-level acceptance criteria.

### Execution authority

`FIRECRAWL_PI_MILESTONES.md` governs:

- milestone order;
- dependencies;
- scope and out-of-scope work;
- milestone implementation work;
- required artifacts;
- automated verification;
- human verification;
- acceptance;
- rollback;
- and milestone state.

### These instructions

This file governs agent behavior while implementing the canonical design.

A direct, current instruction from the owner may alter the task. Otherwise, do not silently reinterpret or redesign the canonical architecture.

If implementation evidence reveals that a canonical architectural assumption is wrong or unsafe:

1. verify the finding;
2. choose the least disruptive correct solution;
3. update **both canonical documents** if the architecture truly changes;
4. record the reason and evidence;
5. rerun affected verification.

Do not create a third canonical architecture, deployment, or milestone document.

Operational artifacts such as code, manifests, scripts, tests, lockfiles, fixtures, and dated evidence reports are allowed and expected.

---

## 3. Current Baseline

Unless M0 evidence or a deliberate canonical update requires otherwise, preserve these selected decisions.

### Firecrawl

- Firecrawl API-image snapshot: `v2.11.162`
- Dereferenced upstream source commit: `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`
- Keep upstream Firecrawl API, crawl machinery, normalization, and useful extraction behavior.
- Do **not** replace Firecrawl with a custom crawler.
- Keep custom upstream changes small, explicit, version-pinned, and patch-managed.

### MCP

- Canonical protocol: **MCP `2026-07-28`**
- Canonical transport: **stateless Streamable HTTP**
- Canonical endpoint: `/mcp`
- Official TypeScript MCP SDK v2
- Selected server package baseline: `@modelcontextprotocol/server@2.1.0`
- Modern implementation must use the modern request-factory/stateless architecture.
- Support SDK-provided stateless compatibility for `2025-11-25`.
- Do not introduce hidden protocol sessions, `Mcp-Session-Id`, or deprecated HTTP+SSE as the primary architecture.

### Core runtime

- Docker Compose, not Kubernetes.
- PostgreSQL 17 / NuQ.
- Redis.
- RabbitMQ.
- No FoundationDB server/init in the selected deployment.
- One NuQ worker initially.
- One active Chromium page/context initially.
- SearXNG for local search.
- A small Firecrawl retrieval integration patch plus project-owned retrieval/browser services.
- Private authenticated gateway.
- Internal data services remain private.

### External gap-closure providers

Selected initial providers are:

- **Decodo** for raw residential proxy traffic.
- **Zyte** for enhanced retrieval.
- A replaceable, budgeted **OpenAI-compatible remote model** for LLM-backed extraction.
- **LlamaParse** as the bounded complex-document fallback.
- **Bright Data** is the alternate raw-proxy provider.
- **ScrapingBee** is the alternate enhanced provider.

Alternates remain disabled unless separately configured and approved.

---

## 4. Milestone Discipline

Work on the **currently authorized milestone only** unless the owner's prompt explicitly authorizes progression across multiple milestones.

Do not skip dependencies because a later milestone seems more interesting or easier.

Milestone sequence:

- **M0** — Read-only environment audit and frozen implementation baseline
- **M1** — Durable, private Firecrawl core
- **M2** — Guarded retrieval integration and resource-safe browser
- **M3** — Authorized REST, durable jobs, and agent access
- **M4** — Modern stateless MCP and tested compatibility
- **M5** — Search, structured extraction, and document capability
- **M6** — Residential proxy and anti-bot routing policy
- **M7** — Enhanced retrieval and practical Cloud-gap closure
- **M8** — Operations, resource stability, recovery, and restore
- **M9** — Final Cloud-utility, MCP, and operational acceptance

For the active milestone:

1. read its Objective, Dependencies, Scope, Out of Scope, Implementation Work, Artifacts, Automated Verification, Human Verification, Acceptance Criteria, and Rollback sections;
2. inspect the relevant current code/configuration before modifying it;
3. implement the complete milestone scope;
4. automate its verification;
5. run the required tests, holding any irreversible live step until the review is addressed (§5);
6. run `/review-2` with every agent on the review model (§5);
7. after the review report is available, save it under `evidence/<milestone>/review/` with repository-relative paths (§5) and run `/address`;
8. rerun every test affected by remediation, then run any held live step;
9. record evidence and milestone status honestly;
10. print the next milestone's kickoff prompt (§5), then stop at the milestone boundary unless progression was explicitly authorized.

Do not declare a milestone accepted because the implementation “looks good.”

---

## 5. Review Contract

After implementation of **every milestone**, run:

```text
/review-2
```

**The review model is Opus 5.5.** Run every agent `/review-2` spawns on it (the Agent tool's `opus` alias, while that alias resolves to Opus 5.5), whatever model the session itself runs on; this overrides the skill's own model pin. If the review model is unavailable, run both agents on one other model, name that model in the saved report, and record the review as a substitution. The review's independence comes from its agents' fresh context, not from a different model.

Where a milestone's required tests include an irreversible live step — a paid or credit-consuming call, live egress, or a destructive restore — run the fixture tests first, then the review and remediation below, and only then that step.

Then, after the review report exists, save it as `evidence/<milestone>/review/REVIEW.md`, with every path made relative to the repository root and nothing §17 keeps out of evidence, and run:

```text
/address
```

Then rerun affected tests, and record each finding's outcome in the saved report:

- fixed, with its commit;
- rejected, with the evidence that it is not a defect;
- deferred, with the later milestone that owns it and the reason. A finding may be deferred only if it lies outside this milestone's canonical Scope, or if closing it needs something that later milestone first supplies (named in the reason, for example a workload it first runs). A critical finding inside that Scope blocks ACCEPTED;
- returned to the earlier milestone that owns it, for M9 only, which has no later milestone; the fix runs as a session in that milestone's scope.

The milestone's verifier, rerun after `/address`, checks that the saved report exists and that every finding in it has one of these outcomes (§26).

`/address` commits each fix; skip its push step while the repository has no remote, because a first push needs a full-history scan.

This is the milestone's review of record. No separate review session runs between milestones unless the owner asks for one: each milestone takes its entry gate from its own Dependencies section in `FIRECRAWL_PI_MILESTONES.md`, starts from its kickoff prompt, reads every saved report under `evidence/*/review/`, and takes every finding deferred to it as its own scope.

Do not skip these because the milestone seems small.

If the active agent/runtime genuinely does not provide these commands, perform an equivalent **separate critical review followed by remediation**, and record that substitution honestly.

A review is not independent merely because the same execution log was reread. The review pass should actively search for:

- violated milestone scope;
- architecture drift;
- untested failure paths;
- security regressions;
- race conditions;
- resource leaks;
- retry multiplication;
- Cloud fallbacks;
- provider cost leakage;
- home-IP spill;
- incomplete rollback;
- missing persistence;
- unsupported capability claims;
- and discrepancies between implementation and the canonical documents.

**Kickoff prompts.** A milestone's close-out ends by printing the next milestone's kickoff prompt: one self-contained, copy-ready code block with absolute paths, carrying this milestone's evidence as fact, and shaped by the "Prompts Written for a Future Session" section of `~/.claude/CLAUDE.md` where that file exists. The prompt is printed, never saved into that file. M9 has no successor and prints none. Every kickoff prompt tells its session that this section, as CLAUDE.md states it when that session runs, is the rule, and names its essentials:

- take its entry gate from its own Dependencies section in `FIRECRAWL_PI_MILESTONES.md`;
- read every saved report under `evidence/*/review/` and take each finding deferred to this milestone as scope;
- run `/review-2` on the review model (Opus 5.5) after implementation, save the report, and run `/address` once the report exists;
- rerun every affected test;
- end its own close-out by printing the following milestone's kickoff prompt with these same instructions.

---

## 6. Autonomy

Once a milestone is authorized, operate with high autonomy inside the project boundary.

You may perform routine milestone-scoped work without repeatedly asking for permission, including:

- install required packages and runtimes;
- build or pull pinned images;
- create project directories;
- create and modify project files;
- create containers;
- configure project services;
- configure project networking;
- create scripts;
- configure systemd units/timers for this project;
- restart project services;
- inspect logs;
- run tests;
- run benchmarks;
- tune resource limits;
- execute failure-injection tests;
- recover failed project services;
- and create evidence artifacts.

Respect the actual permission controls of the environment.

Do not ask the owner to perform a shell command, API call, log inspection, Docker action, or other verification that the agent can perform itself.

Do not ask the same question twice if the answer has already been provided or can be discovered programmatically.

---

## 7. Hard Boundaries Requiring Owner Input

The following are **not** implied by milestone authorization.

Do not:

- purchase a service;
- start a paid subscription;
- enable automatic wallet reload;
- upgrade a paid plan;
- authorize nonzero spending;
- expose a new service publicly to the Internet;
- enable optional hosted ingress that requires account consent;
- reimage the Raspberry Pi;
- destructively repartition or format storage;
- remove unrelated data or services;
- perform broad host cleanup;
- weaken security controls to make a test pass;
- or make destructive changes outside project-owned disposable test state.

If one of these is genuinely required, record it as a blocker and continue every independent task that can still be completed.

Credentials alone are **not** authorization to spend.

Provider credentials, account eligibility, free-credit consent, backup credentials, hosted-product consent, or a real physical hardware fact may require owner input. Ask only when the missing input actually blocks the current required live verification.

---

## 8. M0 Is Strictly Read-Only

M0 is different from all later milestones.

During the M0 environment audit:

- do not install packages;
- do not start new containers;
- do not modify firewall rules;
- do not modify storage;
- do not modify services;
- do not change networking;
- do not enter provider credentials;
- do not begin public ingress setup;
- and do not reimage the Pi.

Use existing read-only probes.

Record missing utilities instead of installing them during the audit.

Compare before/after state to prove that M0 did not alter operational state.

Do not assume the Pi's OS, boot medium, storage layout, Docker state, ports, cooling, or existing workloads from prior context. Discover them.

---

## 9. Preserve Existing Infrastructure

This Pi may already host unrelated services.

Treat unrelated services, containers, data, firewall rules, mounts, ports, and network configuration as protected.

Before changes that could collide with existing infrastructure:

- inspect the current state;
- choose project-specific names, ports, networks, Compose project names, labels, directories, and units;
- and verify after changes that unrelated services remain unchanged.

Never use broad destructive shortcuts such as:

```text
docker system prune --volumes
```

Do not terminate unrelated containers.

Do not reset the whole host firewall.

Do not delete volumes as a troubleshooting shortcut.

Project cleanup must target exact project resources.

---

## 10. Cloud Independence

This project exists specifically to remove Firecrawl Cloud quota as the limiting factor.

Self-hosted operations must not silently use Firecrawl Cloud.

Requirements:

- clients must point explicitly to the self-hosted API;
- no default `api.firecrawl.dev` fallback;
- no hidden Cloud API key dependency;
- no Cloud service as a retry path;
- no Cloud use to bypass a provider budget;
- no Cloud use to make acceptance green.

`PI_CLOUD_ACCESS_ENABLED` remains `false` unless the owner deliberately changes the architecture.

Instrumented verification must demonstrate zero unintended Firecrawl Cloud service attempts.

A feature that genuinely requires Firecrawl Cloud must remain explicitly unsupported or opt-in; never route there silently.

---

## 11. Spending and Provider Controls

Initial paid dispatch is disabled.

The default paid budget is zero.

Do not infer authorization from:

- a configured API key;
- an existing provider account;
- a free-trial account;
- a provider balance;
- or a previous discussion of possible costs.

Paid retrieval requires an explicit approved budget policy.

When paid dispatch is eventually approved:

- reserve cost atomically before dispatch;
- settle actual measurable usage afterward;
- retain conservative reservations for uncertain outcomes;
- fail closed when price is unknown;
- count retries and repair attempts in the same logical budget;
- enforce concurrent spending limits transactionally;
- notify at configured thresholds;
- block at the hard cap;
- never automatically switch to another paid provider;
- never automatically purchase more capacity.

Provider rate cards must be versioned with effective dates.

Do not silently activate ScrapingBee, a LlamaParse paid plan, Bright Data, or any other alternate provider.

---

## 12. Home-IP Protection and Retrieval Policy

The home connection is not a disposable scraping IP pool.

Follow the canonical egress and retrieval policy.

Important invariants include:

- low-risk direct retrieval may use the home connection only within policy;
- protected or bulk work must not spill to the home IP when the required proxy is unavailable;
- known difficult domains may start on an approved higher retrieval tier;
- use shared per-domain pacing across clients and routes;
- respect `Retry-After`;
- authentication/login gates are not anti-bot challenges to bypass;
- classify target errors separately from provider errors;
- do not rotate IPs merely to ignore legitimate rate limits;
- preserve legitimate sticky-session consistency where required;
- never retry the same ineffective strategy indefinitely;
- keep automatic acquisition bounded by the canonical attempt budget;
- permit only one enhanced-provider dispatch per logical page where the spec requires it;
- retain domain routing knowledge only as a bounded expiring policy cache.

Do not design or implement unauthorized access to private accounts, credential gates, paywalls, or protected non-public data.

---

## 13. Retrieval Integration Rules

Do not treat a proxy environment variable or replacement Playwright URL as completion of the retrieval architecture.

The project requires a small, version-pinned Firecrawl integration patch plus project-owned retrieval logic.

The integration must:

- preserve Firecrawl's crawler and normalization pipeline;
- trace every relevant acquisition path;
- prevent upstream retry/racing paths from bypassing policy;
- cover crawl pages, search acquisition, documents, redirects, browser subresources, and other selected paths;
- propagate logical IDs, deadlines, cancellation, and remaining attempt budgets;
- enforce SSRF protections;
- enforce redirect revalidation;
- enforce size/time limits;
- validate content quality before declaring success;
- kill stale browser process trees;
- release permits after failure/cancellation;
- and prevent optional provider failures from taking down ordinary retrieval.

Prefer minimal upstream patches. Keep most custom behavior outside the upstream Firecrawl tree.

Maintain an ordered patch series with hashes and source-call-site coverage.

---

## 14. Browser Rules

Chromium is important infrastructure and must remain bounded.

Initial browser posture:

- native ARM64 execution must be proven;
- one active page/context initially;
- non-root where supported;
- sandbox enabled;
- bounded shared memory and temp space;
- deterministic timeout/cancellation behavior;
- process-tree cleanup;
- browser recycling;
- no casual `--no-sandbox` workaround;
- no unbounded browser pool;
- no arbitrary remote JavaScript execution;
- no generic public CDP surface.

A browser crash must not OOM or take down PostgreSQL, Redis, RabbitMQ, Firecrawl API, or the host.

Static pages should not unnecessarily invoke Chromium.

---

## 15. Pi Resource Discipline

Target host:

- Raspberry Pi 5
- ARM64
- 8 GB RAM
- always-on personal infrastructure

Optimize for **maximum stable useful capability**, not benchmark throughput.

Do not blindly inherit concurrency intended for large x86 servers.

Use the conservative baseline until measurement justifies a change.

Key rules:

- one NuQ worker initially;
- one browser page/context initially;
- respect the project's measured memory envelope;
- include Firecrawl harness child processes in accounting;
- include existing host services in capacity calculations;
- leave browser-burst headroom;
- avoid host OOM;
- avoid sustained thermal/power instability;
- tune one variable at a time;
- preserve at least the acceptance-required host headroom during the final soak;
- do not claim the Pi is sufficient until actual-host evidence supports it.

If a native build would destabilize the Pi and another safe ARM64 build path is available, prefer the safer build path. Do not rely on x86 emulation as production proof.

---

## 16. Security Model

Use:

> **private by default, authenticated when exposed**

Required behavior:

- Firecrawl internal API and data services remain private;
- PostgreSQL, Redis, and RabbitMQ are not publicly exposed;
- remote REST/MCP access is authenticated;
- validate Host and Origin where applicable;
- enforce TLS for remote exposed paths;
- prevent DNS rebinding;
- enforce SSRF controls for URLs, redirects, subresources, provider callbacks, and webhooks;
- strip spoofed internal identity headers;
- do not trust MCP `clientInfo` as authentication;
- owner/scope authorization applies to jobs, results, artifacts, and callbacks;
- secrets do not enter Git;
- secrets do not appear in logs or evidence;
- avoid privileged containers;
- avoid host networking;
- avoid Docker socket mounts;
- remove unnecessary Linux capabilities;
- use read-only filesystems where compatible.

Do not weaken these requirements merely because the system has a single owner.

---

## 17. Secret Handling

Secrets may include:

- gateway tokens;
- MCP credentials;
- proxy credentials;
- enhanced-provider credentials;
- LLM keys;
- parser keys;
- backup credentials;
- webhook signing secrets.

Keep them out of Git.

Use project-owned secret files or equivalent secure runtime injection.

Do not dump `.env`, container environments, authorization headers, cookies, or credentials into evidence.

Backups must not casually include plaintext secrets.

Rotate compromised credentials deliberately.

A secret existing on disk does not prove the corresponding capability is configured or verified.

---

## 18. MCP Implementation Requirements

MCP is a first-class interface, not a decorative wrapper.

The canonical server must:

- target stable MCP `2026-07-28`;
- use stateless Streamable HTTP;
- expose `/mcp`;
- create the server through the official SDK's modern request-factory pattern;
- avoid protocol-level sessions;
- require no hidden persistent connection;
- avoid required initialization for modern clients;
- carry/validate current request metadata as defined by the selected protocol;
- support JSON and request-scoped SSE where applicable;
- use explicit application job handles for long-running work;
- keep REST independently usable if MCP is down;
- support SDK-provided stateless `2025-11-25` compatibility;
- reject malformed modern requests rather than silently downgrading;
- support at least two independent clients;
- survive MCP process restart between related operations;
- survive a new TCP connection between related operations.

Do not mark M4 complete because `tools/list` works.

A real scrape/crawl/status flow through MCP is required.

---

## 19. Durable Jobs and Idempotency

Acknowledged work must be trackable across process failures.

Implement:

- durable receipts;
- explicit owner identity;
- logical submission keys;
- idempotency;
- upstream job mapping;
- result retention;
- pagination;
- uncertain-submission reconciliation;
- cancellation state;
- provider/billing reservations;
- crash-safe transitions.

Test process crashes around submission/acknowledgment boundaries.

Do not blindly resubmit an uncertain job.

Do not claim exactly-once execution where only idempotent at-least-once behavior is actually established.

---

## 20. Provider Isolation

Optional providers must fail independently.

Examples:

- SearXNG failure must not break scrape/crawl.
- LLM failure must not break ordinary acquisition.
- parser failure must not break ordinary HTML retrieval.
- enhanced-provider failure must not break local/browser/proxy paths.
- proxy failure must not force protected/bulk traffic onto the home IP.
- MCP failure must not break REST.

Use distinct circuit breakers and readiness states where appropriate.

Do not collapse the system into one opaque “healthy/unhealthy” status.

---

## 21. Coding and Implementation Style

Prefer clear, inspectable code over cleverness.

### Before patching

- inspect the actual pinned source;
- confirm the relevant call paths;
- confirm whether an environment variable is consumed rather than merely documented;
- confirm route shapes and result schemas;
- search for retry/fallback paths that could bypass policy.

### While implementing

- keep modules focused;
- keep provider adapters replaceable;
- use typed/schema-validated configuration;
- validate configuration at startup;
- make unsupported input fail explicitly;
- keep retry ownership unambiguous;
- use deterministic fixtures for difficult edge cases;
- preserve provenance;
- preserve null/missing values rather than inventing extraction results;
- make cancellation and timeout behavior explicit;
- prefer atomic filesystem/database operations where correctness depends on them;
- keep owner/auth checks centralized and reusable.

### Avoid

- giant rewrites when a thin adapter is sufficient;
- magic environment-variable assumptions;
- floating `main` or uncontrolled `latest`;
- hidden provider fallbacks;
- TODO stubs that are required for milestone acceptance;
- swallow-and-continue error handling that converts failure into false success;
- broad `except`/catch blocks without classification;
- retries layered in several subsystems without a shared budget;
- capability advertising before implementation and tests exist.

---

## 22. Version and Dependency Control

Pin all production-relevant versions.

Maintain `deploy/versions.lock.json` with the resolved implementation baseline, including:

- source SHA;
- upstream tag/release relationship;
- container registry/tag/digest/platform;
- package versions;
- browser revision;
- patch hashes/build provenance.

Do not silently upgrade Firecrawl, MCP, Chromium, PostgreSQL, queue infrastructure, or providers because a newer version exists.

A security-relevant update may justify changing the pinned baseline, but only after review, canonical update where needed, migration testing, and regression verification.

Browser package and browser binary must move together.

Database major upgrades require migration planning and rollback evidence.

---

## 23. Persistence and Storage

Persistent state must survive container recreation and normal reboot.

Use audited data mounts.

Fail closed if the expected data device is absent; do not create a shadow data tree on the root filesystem.

Do not delete named production volumes as a recovery shortcut.

Persistence requirements include the state needed for:

- PostgreSQL/NuQ;
- Redis where required;
- RabbitMQ where required;
- durable job receipts;
- billing reservations;
- retained result metadata/artifacts;
- routing knowledge;
- project configuration;
- backup metadata.

Acceptance requires destructive **container recreation without deleting volumes**, followed by state verification.

---

## 24. Observability

Observability must be useful enough to diagnose failures without exposing secrets.

Structured events should include, where applicable:

- ISO-8601 UTC timestamp;
- service;
- build/source version;
- request ID;
- logical acquisition ID;
- job ID;
- validated owner/client identity;
- MCP revision/tool or REST route;
- target registrable domain;
- initial and final retrieval strategy;
- attempt count;
- result/failure classification;
- status;
- elapsed and queue time;
- browser/proxy/provider usage;
- measured units/bytes;
- reserved/actual/estimated cost;
- cancellation state.

Do not log scraped content by default.

Do not log authorization headers, cookies, URL credentials, API keys, or full sensitive query strings.

Use the canonical `fcpi` operational surface as it becomes available.

---

## 25. Evidence Discipline

Every milestone requires machine-verifiable evidence.

For verification, retain at least:

- command/test ID;
- UTC timestamp;
- source SHA;
- patch hash;
- image digest/platform where relevant;
- configuration/fixture hash;
- expected outcome;
- actual outcome;
- exit code;
- resource/cost measurement where relevant;
- redacted evidence path.

Use milestone states exactly as defined:

- `NOT_STARTED`
- `IN_PROGRESS`
- `IMPLEMENTED_PENDING_LIVE`
- `BLOCKED`
- `ACCEPTED`

Use test states:

- `PASS`
- `FAIL`
- `NOT_RUN`
- `BLOCKED_CREDENTIAL`

Use capability states from the spec where relevant:

- `DESIGNED`
- `IMPLEMENTED_UNVERIFIED`
- `VERIFIED_LOCAL`
- `VERIFIED_LIVE`
- `BLOCKED_CREDENTIAL`
- `UNAVAILABLE`
- `NOT_REQUIRED`

Do not convert a missing credential into a green test.

Do not convert a fixture test into live-provider verification.

Do not use “looks good,” “seems fine,” or package-version presence as acceptance evidence.

---

## 26. Automated Verification First

Anything that can reasonably be checked programmatically must be automated.

This includes:

- shell state;
- container health;
- network reachability;
- API behavior;
- MCP behavior;
- authentication;
- authorization;
- persistence;
- browser output;
- screenshots using controlled fixtures;
- resource usage;
- process cleanup;
- proxy egress;
- provider accounting;
- logs;
- backup;
- restore;
- reboot behavior;
- rollback;
- and failure injection.

Human verification is reserved for:

- actual account/credential consent;
- explicit budget/spend authorization;
- optional hosted-product consent;
- recovery-key custody;
- a physical condition that cannot be observed programmatically.

Do not create a redundant manual checklist when automated assertions can establish the behavior.

---

## 27. Failure Is Data

Do not lower success criteria because a test is difficult.

If a test fails:

1. classify the failure;
2. preserve the evidence;
3. determine whether it is implementation, environment, provider, target, resource, or credential related;
4. fix the underlying issue where in scope;
5. rerun the test;
6. keep the failure visible if unresolved.

Do not remove difficult public targets from a frozen acceptance corpus after seeing results.

Do not call a target's transport `200` successful if the returned page is a challenge, login gate, placeholder, or unusable shell.

Do not reinterpret provider marketing success rates as project evidence.

---

## 28. Backup and Restore

A successful backup command is not sufficient.

Backups are accepted only after restore proof.

The selected design uses encrypted off-device restic backups.

During restore testing:

- use an isolated project namespace;
- disable paid/external dispatch;
- disable webhooks;
- restore matching versions/config/state;
- verify retained result hashes;
- verify jobs/receipts;
- verify ACLs;
- verify REST/MCP fixtures;
- prevent duplicate provider work or notification delivery.

Never run a restored test copy as a second live consumer of production work.

---

## 29. Upgrade and Rollback

Upgrades are controlled, staged, and reversible.

Required pattern:

1. review release/security notes;
2. resolve immutable ARM64 artifacts;
3. verify disk/resource headroom;
4. create a validated pre-upgrade backup;
5. test the candidate in isolation;
6. run compatibility/security/MCP/retrieval/migration tests;
7. cut over deliberately;
8. run functional verification;
9. accept or roll back.

Rollback must restore matching:

- code;
- images;
- configuration;
- patch series;
- database state;
- queue state where schema/version compatibility requires it.

Do not start an older binary against a newly migrated incompatible database merely because the container launches.

---

## 30. Completion Standard

A milestone is complete only when:

- the authorized scope is implemented;
- required artifacts exist;
- automated verification has run;
- acceptance criteria pass or honest blockers are recorded;
- `/review-2` has run on the review model, or its §5 substitution is recorded, and its report is saved under `evidence/<milestone>/review/`;
- `/address` has remediated review findings, and each finding's outcome is recorded in that report;
- every finding an earlier saved review deferred to this milestone has an outcome recorded in this milestone's report;
- affected tests have been rerun;
- evidence is stored and redacted;
- milestone status is updated accurately;
- unrelated host services remain intact;
- no unapproved spending occurred;
- no unintended public exposure occurred;
- no unintended Firecrawl Cloud call occurred.

If a mandatory live credential is missing, finish all independent implementation and fixture verification, then use `IMPLEMENTED_PENDING_LIVE` rather than claiming acceptance.

M9 full acceptance requires current evidence for all mandatory system criteria, including real required external-provider tests and tested off-device restore.

---

## 31. Communication

Keep implementation updates concise and factual.

When reporting status:

- state what was completed;
- state what was verified;
- state what failed;
- state what remains blocked;
- distinguish fixture proof from live proof;
- include relevant evidence paths;
- avoid dumping raw logs unless needed.

Do not ask unnecessary questions before beginning work that can be resolved from the repository, canonical documents, current host state, or existing configuration.

Do not promise future or background work. Perform the authorized work in the active session to the greatest extent possible.

When a real external input is required, ask for the smallest missing input and continue all independent work first.

---

## 32. Guiding Principle

When choosing between two implementations that both satisfy the canonical requirements, prefer the one that:

1. increases useful agent capability;
2. improves retrieval reliability;
3. preserves correctness under failure;
4. keeps resource use stable on the Pi;
5. keeps recurring cost bounded;
6. minimizes unnecessary upstream Firecrawl divergence;
7. remains inspectable and maintainable;
8. avoids needless enterprise complexity.

Do not optimize for passing a superficial checklist.

Build the platform so that its capabilities are **real, measured, recoverable, and useful**.
