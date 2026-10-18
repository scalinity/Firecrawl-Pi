-- The retrieval service's own state (FIRECRAWL_PI_SPEC.md §21.2), in the NuQ database under its own
-- schema. Run by the superuser: scripts/m2/pi-retrieval-db.sh on an existing data directory, and
-- initdb/030-fcpi-retrieval.sh on a new one. The superuser owns the schema and the tables, and the
-- service's role fcpi_retrieval gets DML on them and nothing else, as the core's role has on NuQ's
-- (evidence/M1/closeout/CLOSEOUT.md). Idempotent.
CREATE SCHEMA IF NOT EXISTS fcpi_retrieval AUTHORIZATION postgres;

-- One row per logical page: the attempt budget (spec §9.3), shared by every retry and requeue
-- that reuses the logical id (the core sends the NuQ job id).
CREATE TABLE IF NOT EXISTS fcpi_retrieval.acquisition (
  logical_id  text PRIMARY KEY,
  url_hmac    text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  deadline    timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acquisition_updated_at ON fcpi_retrieval.acquisition (updated_at);

-- One row per attempt, reserved before dispatch; outcome written when it ends.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.attempt (
  attempt_id   uuid PRIMARY KEY,
  logical_id   text NOT NULL,
  ordinal      integer NOT NULL,
  request_id   text,
  purpose      text NOT NULL,
  strategy     text NOT NULL,
  domain       text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  outcome      text,
  target_status integer,
  bytes        bigint,
  subresources integer,
  UNIQUE (logical_id, ordinal)
);
CREATE INDEX IF NOT EXISTS attempt_started_at ON fcpi_retrieval.attempt (started_at);

-- Global permits (spec §29 PI_MAX_URL_ACQUISITIONS, PI_MAX_BROWSER_PAGES): a leased row per slot;
-- a lease that expires is free again, so a crashed holder cannot keep a slot.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.permit (
  kind        text NOT NULL,
  slot        integer NOT NULL,
  holder      uuid,
  lease_until timestamptz,
  PRIMARY KEY (kind, slot)
);

-- Direct-egress pacing per registrable domain (spec §10.2) and 429 cooldowns (spec §9.3), kept
-- across requests and restarts.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.domain_state (
  domain          text PRIMARY KEY,
  holder          uuid,
  hold_until      timestamptz,
  last_nav_at     timestamptz,
  cooldown_until  timestamptz,
  cooldown_s      integer
);
CREATE TABLE IF NOT EXISTS fcpi_retrieval.direct_nav (
  domain   text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  fixture  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS direct_nav_domain_at ON fcpi_retrieval.direct_nav (domain, at);
CREATE INDEX IF NOT EXISTS direct_nav_at ON fcpi_retrieval.direct_nav (at);

-- M5: provider spending (spec §28.3). One row per budget category and period (a day or a month, UTC)
-- holds what is reserved and what is settled; a reservation is one conditional UPDATE per period row,
-- so concurrent callers cannot pass a cap. Amounts are integers in the category's unit (micro-USD, or
-- parser credits).
CREATE TABLE IF NOT EXISTS fcpi_retrieval.budget_usage (
  category      text NOT NULL,
  period        text NOT NULL CHECK (period IN ('day', 'month')),
  period_start  date NOT NULL,
  reserved      bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  settled       bigint NOT NULL DEFAULT 0 CHECK (settled >= 0),
  notified      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (category, period, period_start)
);
-- One row per provider call, reserved before dispatch. call_key names the call inside its logical unit
-- (the logical id, the chunk and whether it is the extraction or its one repair), so a retried request
-- finds the call it already paid for: a SETTLED row's stored result is reused, a RESERVED or UNCERTAIN
-- one is never sent again.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.budget_reservation (
  id            uuid PRIMARY KEY,
  call_key      text NOT NULL UNIQUE,
  logical_id    text NOT NULL,
  category      text NOT NULL,
  provider      text NOT NULL,
  subject       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('extract', 'repair', 'parse')),
  unit          text NOT NULL CHECK (unit IN ('micro_usd', 'credits')),
  rate_card     text NOT NULL,
  request_hash  text NOT NULL,
  reserved      bigint NOT NULL CHECK (reserved > 0),
  actual        bigint CHECK (actual >= 0),
  state         text NOT NULL CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNCERTAIN')),
  day_start     date NOT NULL,
  month_start   date NOT NULL,
  paid_total    boolean NOT NULL,
  usage         jsonb,
  result        jsonb,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);
CREATE INDEX IF NOT EXISTS budget_reservation_logical ON fcpi_retrieval.budget_reservation (logical_id);
CREATE INDEX IF NOT EXISTS budget_reservation_created ON fcpi_retrieval.budget_reservation (created_at);
-- A finite allocation (Serper's lifetime credits) sums its category's retained rows under an advisory lock at each reservation.
CREATE INDEX IF NOT EXISTS budget_reservation_category ON fcpi_retrieval.budget_reservation (category);
-- The category periods a reservation drew on, so its settlement gives back exactly those rows even when
-- the caps changed in between.
ALTER TABLE fcpi_retrieval.budget_reservation ADD COLUMN IF NOT EXISTS periods text[];
-- Micro-USD per unit on the paid total's day row: 1 for a micro-USD category, a parser's micro-USD per credit.
ALTER TABLE fcpi_retrieval.budget_reservation ADD COLUMN IF NOT EXISTS paid_total_rate bigint NOT NULL DEFAULT 1;

-- M5: search (spec §13): identical normalized queries answered from here for 15 minutes; a backend or
-- engine failure is never stored. One row per query sent to the backend, for the hourly cap.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_cache (
  key         text PRIMARY KEY,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS search_cache_expires ON fcpi_retrieval.search_cache (expires_at);
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_query (
  at       timestamptz NOT NULL DEFAULT now(),
  outcome  text NOT NULL
);
CREATE INDEX IF NOT EXISTS search_query_at ON fcpi_retrieval.search_query (at);

-- M5: complex-document parses (spec §15), cached by the document's bytes, the parser, its version and
-- options, and the owner.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.parse_cache (
  key           text PRIMARY KEY,
  owner         text NOT NULL,
  bytes_sha256  text NOT NULL,
  parser        text NOT NULL,
  pages         integer NOT NULL CHECK (pages >= 0),
  markdown      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS parse_cache_expires ON fcpi_retrieval.parse_cache (expires_at);

-- The ledger's kinds, in one definition so applying the file again never meets a row it would refuse: M6's residential
-- proxy spending (a reservation per attempt, kind proxy, and the difference a provider's own usage report shows over
-- what was measured locally, kind reconcile), and M7's enhanced provider, whose one dispatch per logical page is keyed by
-- the page (kind enhanced), so a retried page finds the dispatch it already made instead of paying for another.
-- Search intelligence (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §18): a documentation search, a documentation read
-- and a decision are each one metered operation of their own kind; a search is any general engine's.
ALTER TABLE fcpi_retrieval.budget_reservation DROP CONSTRAINT IF EXISTS budget_reservation_kind_check;
ALTER TABLE fcpi_retrieval.budget_reservation ADD CONSTRAINT budget_reservation_kind_check CHECK (kind IN ('extract', 'repair', 'parse', 'proxy', 'reconcile', 'enhanced', 'search', 'docs_search', 'docs_read', 'decision'));
-- A request counter (Brave, Context7) is its own unit: a request is neither a provider credit nor zero micro-USD.
ALTER TABLE fcpi_retrieval.budget_reservation DROP CONSTRAINT IF EXISTS budget_reservation_unit_check;
ALTER TABLE fcpi_retrieval.budget_reservation ADD CONSTRAINT budget_reservation_unit_check CHECK (unit IN ('micro_usd', 'credits', 'requests'));

-- Search intelligence: each provider account's availability, kept apart from its service breaker (spec §15, §16): a quota
-- exhausted, a rate limit, an authentication failure or a held contract stops new dispatch to that provider alone and
-- survives a restart. retry_basis says whether retry_at is the provider's documented reset, a local estimate, or unknown
-- (then retry_at is null and only a credential change or an operator re-enable resumes it). credential_epoch fingerprints
-- the credential the state was observed with, so a new key is a new epoch.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.provider_availability (
  provider           text NOT NULL,
  profile            text NOT NULL DEFAULT 'default',
  state              text NOT NULL CHECK (state IN ('available', 'rate_limited', 'quota_exhausted', 'auth_failed', 'contract_hold')),
  reason             text,
  provider_code      text,
  observed_at        timestamptz NOT NULL DEFAULT now(),
  retry_at           timestamptz,
  retry_basis        text NOT NULL DEFAULT 'unknown' CHECK (retry_basis IN ('documented', 'estimated', 'unknown')),
  credential_epoch   text,
  contract_failures  integer NOT NULL DEFAULT 0 CHECK (contract_failures >= 0),
  balance            jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, profile)
);

-- M6: domain routing (spec §9.5), at most 5,000 rows keyed by registrable domain (a fixture by its host): a learned
-- residential preference with its set time, expiry and probe, the script-shell learning, and outcome counters. A
-- provider's failure never writes here.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.domain_route (
  domain              text PRIMARY KEY,
  preferred           text CHECK (preferred IN ('residential')),
  set_at              timestamptz,
  expires_at          timestamptz,
  probe_at            timestamptz,
  challenges          integer NOT NULL DEFAULT 0 CHECK (challenges >= 0),
  js_count            integer NOT NULL DEFAULT 0 CHECK (js_count >= 0),
  prefer_browser      boolean NOT NULL DEFAULT false,
  browser_expires_at  timestamptz,
  successes           bigint NOT NULL DEFAULT 0,
  failures            bigint NOT NULL DEFAULT 0,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  last_failure_class  text,
  last_reason         text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domain_route_updated_at ON fcpi_retrieval.domain_route (updated_at);
-- M6: a job's explicit, finite route hold (spec §10.2): while it lasts, the domain's acquisitions need the
-- residential route. Placed and released by the gateway for bulk jobs.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.route_hold (
  domain      text NOT NULL,
  job_id      text NOT NULL,
  reason      text NOT NULL,
  until       timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, job_id)
);
-- M6: reconciliation reads one provider's proxy and reconcile rows of one day (review S10).
CREATE INDEX IF NOT EXISTS budget_reservation_proxy_day ON fcpi_retrieval.budget_reservation (provider, day_start) WHERE kind IN ('proxy', 'reconcile');
-- M6: each reconciliation of locally measured proxy bytes against the provider's usage report for one UTC day.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.proxy_reconciliation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,
  day                   date NOT NULL,
  local_bytes           bigint NOT NULL,
  provider_bytes        bigint NOT NULL,
  adjustment_micro_usd  bigint NOT NULL DEFAULT 0,
  uncertain_settled     integer NOT NULL DEFAULT 0,
  detail                text,
  at                    timestamptz NOT NULL DEFAULT now()
);

-- Search intelligence operational records (spec §21.1): one row per logical execution, one per external operation outcome or
-- availability/circuit transition, and daily reductions behind a watermark. Cost stays in the ledger: these refer to it by
-- logical id and call key and never copy its mutable totals. No raw query or page text: a query is kept as its keyed fingerprint,
-- a URL without its query string. Retention (store.mjs prune): runs 30 days and their candidate traces 14, events 14 days, a run or
-- event only once the daily reduction has moved past its day; daily aggregates 90.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_run (
  logical_id       uuid PRIMARY KEY,
  request_id       text NOT NULL,
  principal_id     text NOT NULL,
  job_id           text,
  fingerprint      text NOT NULL,
  profile          text NOT NULL,
  selection        text NOT NULL,
  result_mode      text NOT NULL,
  accepted_at      timestamptz NOT NULL,
  completed_at     timestamptz,
  outcome          text,
  cache_mode       text,
  docs_active      boolean,
  docs_reason      text,
  ranking_mode     text,
  versions         jsonb NOT NULL,
  summary          jsonb,
  trace            jsonb,
  trace_truncated  boolean NOT NULL DEFAULT false
);
-- The core's search job, which its selected-result scrapes and extraction share: the join from a run to its acquisitions.
ALTER TABLE fcpi_retrieval.search_run ADD COLUMN IF NOT EXISTS job_id text;
CREATE INDEX IF NOT EXISTS search_run_accepted ON fcpi_retrieval.search_run (accepted_at);
-- The allowed values are replaced whole, so a database created by an earlier version takes new ones (a refused admission,
-- a deadline's timeout): a CHECK written inside CREATE TABLE IF NOT EXISTS would never reach it.
ALTER TABLE fcpi_retrieval.search_run DROP CONSTRAINT IF EXISTS search_run_outcome_check;
ALTER TABLE fcpi_retrieval.search_run ADD CONSTRAINT search_run_outcome_check CHECK (outcome IN ('complete', 'partial', 'failed', 'cancelled', 'timeout', 'refused'));
CREATE INDEX IF NOT EXISTS search_run_job ON fcpi_retrieval.search_run (job_id) WHERE job_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_event (
  event_id        uuid PRIMARY KEY,
  logical_id      uuid,
  operation       text,
  provider        text NOT NULL,
  event_type      text NOT NULL,
  observed_at     timestamptz NOT NULL,
  started_at      timestamptz,
  duration_ms     integer,
  queue_ms        integer,
  status          text,
  reason          text,
  code            text,
  retry_at        timestamptz,
  result_count    integer,
  eligible_count  integer,
  cache_origin    text,
  dispatch_state  text,
  detail          jsonb
);
CREATE INDEX IF NOT EXISTS search_event_observed ON fcpi_retrieval.search_event (observed_at);
CREATE INDEX IF NOT EXISTS search_event_logical ON fcpi_retrieval.search_event (logical_id);
-- The ledger reservations an event's operation made, by call key (search:<logical id>:<provider>:<operation>:...): a lane's,
-- a rerank's batches, a Ref read's. A documentation activation's one Jev call is search:<logical id>:jev:docs_detect:...
-- detail.usage and the run's summary.usage are the responses' own usage observations; settled amounts are the ledger's.
ALTER TABLE fcpi_retrieval.search_event ADD COLUMN IF NOT EXISTS call_keys text[];
ALTER TABLE fcpi_retrieval.search_event DROP CONSTRAINT IF EXISTS search_event_event_type_check;
ALTER TABLE fcpi_retrieval.search_event ADD CONSTRAINT search_event_event_type_check CHECK (event_type IN ('lane', 'decision', 'docs_activation', 'ref_read', 'evidence', 'availability', 'breaker'));
-- A day's counts, durations (total and a fixed-bucket histogram) and ledger-linked usage, by low-cardinality profile and
-- provider ('*' for the run itself). Recomputed whole for the days a reduction covers, so a repeat changes nothing.
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_daily (
  day        date NOT NULL,
  profile    text NOT NULL,
  provider   text NOT NULL,
  metric     text NOT NULL,
  n          bigint NOT NULL,
  total_ms   bigint,
  histogram  jsonb,
  amount     numeric,
  PRIMARY KEY (day, profile, provider, metric)
);
CREATE TABLE IF NOT EXISTS fcpi_retrieval.search_reduction (
  name             text PRIMARY KEY,
  reduced_through  date NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fcpi_retrieval') THEN
    CREATE ROLE fcpi_retrieval LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE ALL ON SCHEMA fcpi_retrieval FROM PUBLIC;
GRANT USAGE ON SCHEMA fcpi_retrieval TO fcpi_retrieval;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fcpi_retrieval TO fcpi_retrieval;
-- The service reads nothing of NuQ's.
REVOKE ALL ON SCHEMA nuq FROM fcpi_retrieval;
