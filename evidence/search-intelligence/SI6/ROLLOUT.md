# Search intelligence: rollout and rollback

The release takes the Pi from the deployed `5d91186` (an ancestor of the release, so `scripts/m1/deploy.sh` accepts it) to the aggregate search: five general engines asked together, Context7 and Ref for documentation queries, Jev reranking, and the bounded operational records (`docs/FIRECRAWL_PI_SPEC.md` §13; `docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`). It follows spec §27's upgrade procedure with the project's own `fcpi` surface: headroom, a validated backup, a staged candidate and its plan, a hold and drain, one controlled cutover, functional checks, a recorded release. Nothing here has run against the Pi: the cutover waits on the owner's launch authorization (the one remaining boundary, below). `node scripts/si6/verify.mjs` checks every step's record as it lands.

## What changes on the Pi

| Part | Change | How it arrives |
|---|---|---|
| Core (`firecrawl-core`) | Patch 0011: the caller's original query, options, trusted context and deadline reach the coordinator; the bounded evidence payload (series `91e3d278…`, result tree `7a59ba45…`, image `c2585732…`) | Built on the Colima VM (D6, `raw/api-build.log`), carried to the Pi |
| Retrieval service | The coordinator, the seven provider adapters, Jev decisions, the evidence hook, the operational records | Built on the Pi from the staged release candidate (`fcpi/retrieval:si6`) |
| Access gateway | `searchIntelligence` validation; the search's trusted headers | Built on the Pi from the candidate (`fcpi/access-gateway:si6`) |
| MCP gateway | The search tool's options; `fcpi.search` compaction | Built on the Pi from the candidate (`fcpi/mcp-gateway:si6`) |
| Retrieval schema | Additive: `search_run`, `search_event`, `search_daily`, `search_reduction`, `provider_availability`, new ledger kinds and the `requests` unit (widened CHECKs, nullable or defaulted columns) | Applied by the cutover (`scripts/m2/pi-retrieval-db.sh`, idempotent, as superuser over the local socket) |
| Policies | `budget.json` (the search providers, their categories and rate cards, `searching.profile: "aggregate"`), `egress.json` (`search.intelligence`), `capabilities.json` (the search options) | Mounted from `/opt/firecrawl-pi/deploy/policies` |
| Credentials | Seven new provider keys (Serper's is already present) | `scripts/si6/install-keys.sh`, stdin only |

`deploy/compose.yaml` keeps its shape: only the four image pins change. The browser worker is unchanged and not rebuilt.

**Spend once live.** Paid dispatch is on at the Pi (`/etc/firecrawl-pi/paid-dispatch.env`), and the search categories carry no monetary cap (spec §28.3): the 60-searches-an-hour admission bounds them. Measured in SI5 from profile D's own `usage` (`evidence/search-intelligence/SI5/eval/runs/*.json`, `profiles.D.usage`, 120 searches):
- **Expected:** 19,442 micro-USD a search on average (p95 19,767): Exa 17,000 (settled from its `costDollars`), DeepSeek 737, Jev about 1,700 (10.2 decisions of about 172 each). At the admission's 60 an hour that is about $1.17 an hour.
- **Ceiling:** a search's reservations are at most Exa's 37,000 (settled at the reservation when `costDollars` is absent), DeepSeek's 750 and up to 13 Jev decisions of at most about 962: about 50,000 micro-USD, so at most about $3.00 an hour of metered USD.
- **Not metered in USD:** one Serper credit a search from its fixed allocation (no renewal); one Brave request; two Tavily credits (its 1,000 free monthly credits last about 8 hours at saturation, then $0.008 each, about $0.96 an hour more); for a documentation search, one Context7 request per library scope and one to three Ref credits (each search or read is one).

## Gates before the cutover

1. The owner's launch authorization: the cutover changes a running deployment target, which this feature's kickoff does not authorize on its own.
2. SI5's acceptance matrix (`evidence/search-intelligence/SI5/ACCEPTANCE.md`) read, with its blocked and failed criteria accepted or remedied.
3. `node scripts/si6/verify.mjs` passing every check it can run before the cutover: the build of record (clean tree, `no_cache=1`, series `91e3d278…`), the native chain 25 of 25 on that image, and the lock builder's guards.
4. The Colima VM for step 4 (CLAUDE.md §33.7): `colima status`; if it is stopped, a bare `colima start`, and `colima stop` after step 4 only when this run started it.

## Rollout, in order

Run from the release commit on the workstation with a clean tree, in one shell. The SSH command is an array, because zsh does not split a scalar (CLAUDE.md §33.6). Each step's checks print `STOP: …` and change nothing further when they fail; stop there.

```sh
R=evidence/search-intelligence/SI6/raw
. scripts/m1/pi-target.conf
SSH=(ssh -i "$PI_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$PI_SSH_TARGET")
```

**1. Host state before** (CLAUDE.md §33.1), and the firewall by its canonical hashes.

```sh
scripts/m1/snapshot.sh $R/snapshot-before.txt
"${SSH[@]}" 'bash -s' < scripts/host/pi-firewall.sh > $R/firewall-before.txt
```

**2. Headroom and a validated backup** (spec §27), while the previous release runs.

```sh
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi status' > $R/status-before.txt
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi backup' > $R/backup-before.txt
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi restore-test' > $R/restore-test-before.txt
[ "$(tail -1 $R/restore-test-before.txt | jq -r .result)" = PASS ] || echo "STOP: the pre-upgrade backup did not restore"
```

**3. Retain the running images**, before any tag moves. A pin resolves only through a name in its image's repository, and steps 4 and 5 load and build new images: the `retained-5d91186` tags keep the previous release's five images named, so the full rollback needs no rebuild.

```sh
"${SSH[@]}" 'set -e; for p in firecrawl-core:firecrawl-api retrieval-service:retrieval access-gateway:access-gateway mcp-gateway:mcp-gateway browser-worker:browser; do
  c=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=${p%%:*} </dev/null)
  id=$(sudo -n docker inspect -f "{{.Image}}" "$c" </dev/null)
  sudo -n docker image tag "$id" "fcpi/${p#*:}:retained-5d91186" </dev/null
  echo "retained fcpi/${p#*:} $id"
done' > $R/retained.txt
[ "$(grep -c '^retained fcpi/' $R/retained.txt)" = 5 ] || echo "STOP: not every running image is retained"
```

**4. Carry the API image of record to the Pi and pin it.** The pin is written and committed only when the Pi holds the logged image.

```sh
id=$(sed -n 's/^id=\(sha256:[0-9a-f]\{64\}\) os=linux arch=arm64 .*/\1/p' $R/api-build.log)
if scripts/m5/push-api-image.sh $R/api-build.log > $R/api-push.txt && grep -x "pi_image=$id arm64" $R/api-push.txt >/dev/null; then
  sed -i '' -E "s#fcpi/firecrawl-api@sha256:[0-9a-f]{64}#fcpi/firecrawl-api@${id}#" deploy/compose.yaml
  [ "$(grep -c "fcpi/firecrawl-api@${id}" deploy/compose.yaml)" = 1 ] && git add deploy/compose.yaml && git commit -m "build(search-intelligence): run the API image built with patch series 91e3d278"
else echo "STOP: the Pi does not hold $id (see $R/api-push.txt)"; fi
```

**5. Stage the release candidate and build the three service images from it.** `scripts/m8/stage.sh` sends `git archive` of the commit to `/opt/firecrawl-pi-candidate/<commit 12>/`, every hash verified, without touching the deployed tree; the images are tagged `:si6`, so no running pin's tag moves. The pins are committed only when every build is recorded.

```sh
scripts/m8/stage.sh HEAD
c=$(git rev-parse --short=12 HEAD)
"${SSH[@]}" "bash -s -- /opt/firecrawl-pi-candidate/${c}" < scripts/si6/pi-build-images.sh > $R/image-build.txt
ok=yes; [ "$(tail -1 $R/image-build.txt)" = end ] || ok=no
for i in retrieval access-gateway mcp-gateway; do
  id=$(sed -n "s#^fcpi/${i}:si6 id=\(sha256:[0-9a-f]\{64\}\) .*#\1#p" $R/image-build.txt | tail -1)
  if [ "$ok" = yes ] && [[ $id =~ ^sha256:[0-9a-f]{64}$ ]]; then sed -i '' -E "s#fcpi/${i}@sha256:[0-9a-f]{64}#fcpi/${i}@${id}#" deploy/compose.yaml; else ok=no; echo "STOP: no recorded fcpi/${i}:si6 build"; fi
done
if [ "$ok" = yes ]; then git add deploy/compose.yaml && git commit -m "build(search-intelligence): run the service images built from ${c}"; else git checkout -- deploy/compose.yaml; fi
```

**6. Stage the release commit and take the upgrade plan.**

```sh
scripts/m8/stage.sh HEAD
"${SSH[@]}" "sudo -n /opt/firecrawl-pi/scripts/fcpi upgrade --plan /opt/firecrawl-pi-candidate/$(git rev-parse --short=12 HEAD)" > $R/upgrade-plan.json
jq '{from_commit, to_commit, version_lock_changes}' $R/upgrade-plan.json
```

The plan moves the four images named above and no data service. It reports the retrieval schema file as changed; the change is additive, so the previous code runs on the new schema and neither direction restores data. The candidate is not run on copied production data in an isolated namespace: the Pi's 8 GB holds one stack. What stands in for it: the schema applied over a populated baseline database and again (`services/retrieval/test/si-store.test.mjs`), the release's retrieval code collecting 120 live searches on its own database (`evidence/search-intelligence/SI5/eval/`), and the patched core against the coordinator (`raw/native-chain-release-image.txt`).

**7. Deploy, install the keys and cut over, back to back.** From the deploy until the cutover's recreate, the deployed policies are the release's while the previous retrieval image runs, and that image refuses the new budget policy at startup: a restart in this window (a crash, `fcpi paid on|off`, a reboot) leaves acquisition down until the cutover completes. Run the three at once, with no `fcpi paid` change between them; if the cutover cannot run, deploy a forward commit restoring `5d91186`'s three policies. The cutover runs detached on the Pi (`systemd-run`), so a dropped SSH connection cannot stop it mid-recreate; its record is fetched when its end marker is written.

```sh
scripts/m1/deploy.sh
scripts/si6/install-keys.sh > $R/keys.txt
"${SSH[@]}" 'sudo -n systemd-run --unit=fcpi-si6-cutover --collect -p StandardOutput=file:/var/tmp/fcpi-si6-cutover.txt -p StandardError=inherit bash /opt/firecrawl-pi/scripts/si6/pi-cutover.sh'
until "${SSH[@]}" 'grep "^end_marker=" /var/tmp/fcpi-si6-cutover.txt >/dev/null 2>&1'; do sleep 15; done
"${SSH[@]}" 'cat /var/tmp/fcpi-si6-cutover.txt' > $R/cutover.txt
grep '^end_marker=reached ' $R/cutover.txt || echo "STOP: the cutover did not complete; read $R/cutover.txt, then the rollback below"
```

The cutover holds new work at the gateway, drains for up to five minutes, refuses while a job is in flight or a reservation younger than the longest call the policies allow is held, refuses when a pin does not resolve, applies the schema, recreates the four services (900 s bound), and records the release with `fcpi release`.

**8. Verify** (the functional check, then the search itself).

```sh
"${SSH[@]}" 'sudo -n /opt/firecrawl-pi/scripts/fcpi verify functional' > $R/verify-functional.txt
```

- **A live search through the Pi** with `sshForward()` (`scripts/playground/server.mjs`): `forward({ method: "POST", path: "/v2/search", timeout: 70, body: { query: "How do I declare reactive state with ref() in Vue 3.5?", limit: 5, searchIntelligence: { documentation: "required" } } })`. Expect `fcpi.search.profile` `aggregate`, every general lane in `fcpi.search.providers`, documentation activated, `ranking.mode` `hybrid` and rows carrying `fcpi.search`. Then the same through MCP `firecrawl_search` from a client that has reconnected (a connected client keeps its old schema).
- **The ledger** (read-only): `select provider, kind, unit, state, count(*), sum(actual) from fcpi_retrieval.budget_reservation where created_at > now() - interval '1 hour' and kind in ('search','docs_search','docs_read','decision') group by 1,2,3,4;` through `"${SSH[@]}" 'sudo -n docker exec -i fcpi-nuq-postgres-1 psql -q -U postgres -d postgres -At'`. Expect SETTLED or RELEASED rows; a RESERVED or UNCERTAIN row left behind is a finding.
- **The records**: rows in `fcpi_retrieval.search_run` and `search_event` for that search; the retrieval service's `/internal/providers` shows `searchIntelligence.serperBalance`.
- **The legacy route** `GET /searxng/search` still answers (the core's old path), and a scrape, a crawl and a map still pass.
- **The Pi measurements SI5 could not take** (spec §23.3, criterion L01): at least 30 cold link-only searches with one search active at a time, and 30 cold documentation searches. Record p50, p95, the deadline and resident memory, labelled live. Then, with the fixture selection, a stalled discovery provider and a stalled Jev (`/etc/firecrawl-pi/selection`, as the M5–M7 fixture runs did). The target is p95 ≤ 23 s single-active.

**9. The version lock**, from that evidence: it refuses unless the cutover is of HEAD, each image is running, healthy, its build recorded and HEAD's pin, and every entry outside SI6's own is unchanged.

```sh
node scripts/si6/build-lock.mjs && git add deploy/versions.lock.json && git commit -m "build(search-intelligence): record the release in the version lock"
```

**10. Host state after**, attributed line by line against the snapshot before, then the redaction scan last (CLAUDE.md §33.2: it reads the live secrets' hashes on the Pi, the new provider keys among them, and scans the repository), and the verifier.

```sh
scripts/m1/snapshot.sh $R/snapshot-after.txt
"${SSH[@]}" 'bash -s' < scripts/host/pi-firewall.sh > $R/firewall-after.txt
node scripts/m9/redaction.mjs --out $R/redaction.json
node scripts/si6/verify.mjs
```

## What the proxy ledger shows after the cutover

- **An hourly `proxy_reconcile_failed` line is expected.** Once paid dispatch is on and the usage report's credential is present, the retrieval service's hourly loop reconciles the selected proxy's last closed UTC day against that report. Decodo's budget-policy entry has `usageDedicated: false` (its report covers the whole account, not only this deployment), so `reconcileDay` refuses it with `RECONCILE_SCOPE_UNKNOWN` and the loop logs that code each hour. No Decodo day is reconciled automatically, and the line is not a fault; the Decodo dashboard is the check on its spend.
- **A proxy row that a stopped service left behind** is marked UNCERTAIN at the next start: it stays counted in full, in the usage of the day and month it was reserved in, is listed under `uncertain` in the providers status, and no longer holds its day open to reconciliation. The loop reconciles only the last closed day and no command reconciles an older one, so reconciliation never settles such a row afterwards.

## Rollback

**Fast, keeping the release's code:** the legacy profile is the tested rollback, Serper first with the SearXNG fallback, keeping domain constraints since `6c2c8a5`. It recreates only the retrieval service, under the same hold and drain, and records the release.

```sh
sed -i '' 's/"profile": "aggregate"/"profile": "legacy"/' deploy/policies/budget.json   # the one occurrence; the layout is kept
git add deploy/policies/budget.json && git commit -m "revert(search-intelligence): answer searches with the legacy profile"
scripts/m1/deploy.sh
"${SSH[@]}" 'sudo -n systemd-run --unit=fcpi-si6-rollback --collect -p StandardOutput=file:/var/tmp/fcpi-si6-rollback.txt -p StandardError=inherit bash /opt/firecrawl-pi/scripts/si6/pi-cutover.sh --rollback retrieval-service'
until "${SSH[@]}" 'grep "^end_marker=" /var/tmp/fcpi-si6-rollback.txt >/dev/null 2>&1'; do sleep 15; done
"${SSH[@]}" 'cat /var/tmp/fcpi-si6-rollback.txt' > $R/rollback-fast.txt
node scripts/si6/build-lock.mjs --policy-only && git add deploy/versions.lock.json && git commit -m "build(search-intelligence): record the legacy profile in the version lock"
```

The budget validator accepts `aggregate` or `legacy` (`services/retrieval/src/budget.mjs`).

**Full, to the previous release:** `deploy.sh` deploys only descendants of what is deployed, so the rollback is a forward commit whose code, image pins, policies, version lock and patch series are `5d91186`'s. Files the release added are removed; evidence and the SI6 scripts (which the rollback itself runs) stay. The previous images are named by step 3's `retained-5d91186` tags, so nothing is rebuilt. The additive schema stays: the previous code does not read the new tables or columns. `--rollback` proceeds after the drain whatever is in flight, recording it, since a failed release can leave work that never finishes.

```sh
git diff --name-only --no-renames --diff-filter=A 5d91186 HEAD -- . ':(exclude)evidence' ':(exclude)scripts/si6' | xargs git rm -q --
git checkout 5d91186 -- . ':(exclude)evidence' ':(exclude)scripts/si6'
git commit -m "revert(search-intelligence): return to the previous release's code, images, configuration and patch series"
scripts/m1/deploy.sh
"${SSH[@]}" 'sudo -n systemd-run --unit=fcpi-si6-rollback --collect -p StandardOutput=file:/var/tmp/fcpi-si6-rollback.txt -p StandardError=inherit bash /opt/firecrawl-pi/scripts/si6/pi-cutover.sh --rollback'
until "${SSH[@]}" 'grep "^end_marker=" /var/tmp/fcpi-si6-rollback.txt >/dev/null 2>&1'; do sleep 15; done
"${SSH[@]}" 'cat /var/tmp/fcpi-si6-rollback.txt' > $R/rollback-full.txt
grep '^end_marker=reached ' $R/rollback-full.txt
```

The new provider keys can stay: the previous policy does not name them. Remove the `retained-5d91186` tags only once the release is accepted.

## The one remaining boundary

The cutover itself, steps 1 to 10 above, together with the Pi measurements after it. It changes the running deployment, and spends on the new providers for every search the owner's clients send. The owner's launch authorization is what clears it.
