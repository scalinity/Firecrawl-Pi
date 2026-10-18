# Search intelligence: rollout and rollback

The release takes the Pi from the deployed `5d91186` (an ancestor of the release, so `scripts/m1/deploy.sh` accepts it) to the aggregate search: five general engines asked together, Context7 and Ref for documentation queries, Jev reranking, and the bounded operational records (`docs/FIRECRAWL_PI_SPEC.md` §13; `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`). Every command below uses the project's existing scripts, or the SI6 helpers in `scripts/si6/` written on their pattern. Nothing here has run against the Pi: the cutover waits on the owner's launch authorization (the one remaining boundary, below).

## What changes on the Pi

| Part | Change | How it arrives |
|---|---|---|
| Core (`firecrawl-core`) | Patch 0011: the caller's original query, options, trusted context and deadline reach the coordinator; the bounded evidence payload (series `681f37a1…`, result tree `c14e9089…`) | The API image built on the Colima VM (D6), carried to the Pi |
| Retrieval service | The coordinator, the seven provider adapters, Jev decisions, the evidence hook, the operational records | Rebuilt on the Pi from the deployed commit |
| Access gateway | `searchIntelligence` validation; the search's trusted headers | Rebuilt on the Pi |
| MCP gateway | The search tool's options; `fcpi.search` compaction | Rebuilt on the Pi |
| Retrieval schema | Additive: `search_run`, `search_event`, `search_daily`, `search_reduction`, `provider_availability`, `search_cache`, new ledger kinds and the `requests` unit | `scripts/m2/pi-retrieval-db.sh` (idempotent, as superuser over the local socket) |
| Policies | `budget.json` (the search providers, their categories and rate cards, `searching.profile: "aggregate"`), `egress.json` (`search.intelligence`), `capabilities.json` (the search options) | Mounted from `/opt/firecrawl-pi/deploy/policies` |
| Credentials | Seven new provider keys (Serper's is already present) | `scripts/si6/install-keys.sh`, stdin only |

`deploy/compose.yaml` keeps its shape: only the four image pins change.

**Spend once live.** Paid dispatch is on at the Pi (`/etc/firecrawl-pi/paid-dispatch.env`). Each uncached search costs about $0.019 (Exa about $0.017, DeepSeek $0.00075, Jev about $0.001–0.002), plus one Serper credit from its fixed allocation, one Brave request and two Tavily credits. A documentation search adds one Context7 request and one to three Ref credits (each Ref search or read is one credit). The search categories have no monetary cap (spec §28.3): the 60-searches-an-hour admission bounds the spend, at most about $1.20 an hour of metered USD. Measured per query in SI5: `evidence/search-intelligence/SI5/eval/runs/*.json` (`ledger`).

## Gates before the cutover

1. The owner's launch authorization: the cutover changes a running deployment target, which this feature's kickoff does not authorize on its own.
2. SI5's acceptance matrix (`evidence/search-intelligence/SI5/ACCEPTANCE.md`) read, with its blocked and failed criteria accepted or remedied.
3. The build of record exists: `evidence/search-intelligence/SI6/raw/api-build.log` (clean tree, `no_cache=1`, series `681f37a1…`).
4. No job in flight (the cutover script refuses otherwise).

## Rollout, in order

Run from the release commit on the workstation, with a clean tree. `. scripts/m1/pi-target.conf` provides `PI_SSH_KEY` and `PI_SSH_TARGET`; `SSH` below is `ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$PI_SSH_TARGET"`.

```sh
R=evidence/search-intelligence/SI6/raw
# 1. Host state before (CLAUDE.md §33.1), and the firewall by its canonical hashes.
scripts/m1/snapshot.sh $R/snapshot-before.txt
$SSH 'bash -s' < scripts/host/pi-firewall.sh > $R/firewall-before.txt

# 2. Carry the API image of record to the Pi (Colima running) and pin it.
scripts/m5/push-api-image.sh $R/api-build.log > $R/api-push.txt
id=$(sed -n 's/^id=\(sha256:[0-9a-f]\{64\}\) os=linux arch=arm64 .*/\1/p' $R/api-build.log)
sed -i '' -E "s#fcpi/firecrawl-api@sha256:[0-9a-f]{64}#fcpi/firecrawl-api@$id#" deploy/compose.yaml
git add deploy/compose.yaml && git commit -m "build(search-intelligence): run the API image built with patch series 681f37a1"

# 3. Deploy the release (files only; nothing is recreated yet).
scripts/m1/deploy.sh

# 4. The seven provider keys (presence is all it prints).
scripts/si6/install-keys.sh

# 5. Build the service images on the Pi from the deployed commit and pin the three that changed (the script also builds the
#    browser worker, whose code is unchanged: its pin stays).
$SSH 'bash -s' < scripts/m7/pi-build-images.sh > $R/image-build.txt
for i in retrieval access-gateway mcp-gateway; do
  id=$(sed -n "s#^fcpi/$i:m7 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p" $R/image-build.txt | tail -1)
  sed -i '' -E "s#fcpi/$i@sha256:[0-9a-f]{64}#fcpi/$i@$id#" deploy/compose.yaml
done
git add deploy/compose.yaml && git commit -m "build(search-intelligence): run the service images built from $(git rev-parse --short HEAD)"
scripts/m1/deploy.sh

# 6. Cut over: the schema, then the four services recreated together (refuses while work is in flight).
$SSH 'bash -s' < scripts/si6/pi-cutover.sh > $R/cutover.txt
grep '^end_marker=reached ' $R/cutover.txt

# 7. The version lock, from that evidence (it refuses unless each image is running, healthy and its build logged).
node scripts/si6/build-lock.mjs
git add deploy/versions.lock.json && git commit -m "build(search-intelligence): record the release in the version lock"

# 8. Host state after, attributed line by line against the snapshot before.
scripts/m1/snapshot.sh $R/snapshot-after.txt
$SSH 'bash -s' < scripts/host/pi-firewall.sh > $R/firewall-after.txt
```

## Verification after the cutover

- **A live search through the Pi** with `sshForward()` (`scripts/playground/server.mjs`, the desktop app's forwarder): `forward({ method: "POST", path: "/v2/search", timeout: 70, body: { query: "How do I declare reactive state with ref() in Vue 3.5?", limit: 5, searchIntelligence: { documentation: "required" } } })`. Expect `fcpi.search.profile` `aggregate`, every general lane in `fcpi.search.providers`, documentation activated, `ranking.mode` `hybrid` and rows carrying `fcpi.search`. Then the same through MCP `firecrawl_search` from a client that has reconnected (a connected client keeps its old schema).
- **The ledger** (read-only): `select provider, kind, unit, state, count(*), sum(actual) from fcpi_retrieval.budget_reservation where created_at > now() - interval '1 hour' and kind in ('search','docs_search','docs_read','decision') group by 1,2,3,4;` through `$SSH 'sudo -n docker exec -i fcpi-nuq-postgres-1 psql -q -U postgres -d postgres -At'`. Expect SETTLED or RELEASED rows; a RESERVED or UNCERTAIN row left behind is a finding.
- **The records**: rows in `fcpi_retrieval.search_run` and `search_event` for that search; `/internal/providers` (the gateway's status) shows `searchIntelligence.serperBalance`.
- **The legacy route** `GET /searxng/search` still answers (the core's old path), and a scrape, a crawl and a map still pass.
- **The Pi measurements SI5 could not take** (spec §23.3, criterion L01): at least 30 cold link-only searches with one search active at a time, and 30 cold documentation searches. Record p50, p95, the deadline and resident memory, labelled live. Then, with the fixture selection, a stalled discovery provider and a stalled Jev (`/etc/firecrawl-pi/selection`, as the M5–M7 fixture runs did). The target is p95 ≤ 23 s single-active.

## Rollback

**Fast, keeping the release's code:** the legacy profile is the tested rollback. It is Serper first with the SearXNG fallback, and since `6c2c8a5` it keeps domain constraints.

```sh
sed -i '' 's/"profile": "aggregate"/"profile": "legacy"/' deploy/policies/budget.json   # the one occurrence; the layout is kept
git add deploy/policies/budget.json && git commit -m "revert(search-intelligence): answer searches with the legacy profile"
scripts/m1/deploy.sh
$SSH 'sudo -n docker compose -p fcpi -f /opt/firecrawl-pi/deploy/compose.yaml up -d --no-deps --wait --force-recreate retrieval-service </dev/null'
```

The budget validator accepts `aggregate` or `legacy` (`services/retrieval/src/budget.mjs`).

**Full, to the previous release:** `deploy.sh` deploys only descendants of what is deployed, so the rollback is a forward commit. It restores the previous release's image pins and its three policies; the service code is baked into the images and only the policies are mounted. The additive schema stays: the previous code does not read the new tables or columns.

```sh
git checkout 5d91186 -- deploy/compose.yaml deploy/policies/budget.json deploy/policies/egress.json deploy/policies/capabilities.json
git commit -m "revert(search-intelligence): run the previous release's images and policies"
scripts/m1/deploy.sh
$SSH 'bash -s' < scripts/si6/pi-cutover.sh > evidence/search-intelligence/SI6/raw/rollback.txt
grep '^end_marker=reached ' evidence/search-intelligence/SI6/raw/rollback.txt
```

The previous images (`ea5e60e2…`, `bb2ab368…`, `0d6a5218…`, `eebafe80…`) stay on the Pi until pruned, so this rollback needs no rebuild. The new provider keys can stay: the previous policy does not name them.

## The one remaining boundary

The cutover itself, steps 1 to 8 above, together with the Pi measurements after it. It changes the running deployment, and spends on the new providers for every search the owner's clients send. The owner's launch authorization is what clears it.
