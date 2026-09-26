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
