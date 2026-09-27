-- The platform ledger (FIRECRAWL_PI_SPEC.md §16.2, §21.2): durable receipts, owner-scoped idempotency,
-- upstream mapping and the manifest of archived results, in the NuQ database under its own schema.
-- Run by the superuser: scripts/m3/pi-platform-db.sh on an existing data directory, and
-- initdb/040-fcpi-platform.sh on a new one. The superuser owns the schema, the tables and the
-- function; the gateway's role fcpi_gateway gets DML on the tables and EXECUTE on the one function,
-- and nothing else, as the core's and the retrieval service's roles have (CLAUDE.md §33.1). NuQ's
-- rows are never the receipt: pg_cron deletes them (evidence/M1/review/REVIEW.md, R9). Idempotent.
\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS fcpi_platform AUTHORIZATION postgres;

-- One row per acknowledged asynchronous submission: a crawl or batch scrape the core runs, or (M5) an
-- extraction the gateway runs itself. The id is the external job id clients see; submission_key is the
-- logical submission key the gateway writes into the upstream request's `origin`, so a reconciler can find
-- an upstream job whose answer was lost, and an extraction's logical id at the model adapter.
CREATE TABLE IF NOT EXISTS fcpi_platform.job (
  id                  uuid PRIMARY KEY,
  principal           text NOT NULL,
  client_label        text NOT NULL,
  kind                text NOT NULL CONSTRAINT job_kind_check CHECK (kind IN ('crawl', 'batch', 'extract')),
  state               text NOT NULL CHECK (state IN ('RECEIVED', 'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'QUEUED', 'RUNNING',
                                                     'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED')),
  submission_key      text NOT NULL UNIQUE,
  request_hash        text NOT NULL,
  request             jsonb NOT NULL,
  units               integer NOT NULL CHECK (units > 0),
  upstream_id         uuid UNIQUE,
  submitter           uuid,
  dispatch_attempts   integer NOT NULL DEFAULT 0,
  next_dispatch_at    timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  submit_started_at   timestamptz,
  submitted_at        timestamptz,
  deadline            timestamptz,
  cancel_requested_at timestamptz,
  cancel_sent_at      timestamptz,
  finished_at         timestamptz,
  results_expire_at   timestamptz,
  metadata_expire_at  timestamptz NOT NULL,
  upstream_status     text,
  completed           integer,
  total               integer,
  credits_used        integer,
  archived            integer NOT NULL DEFAULT 0,
  errors              jsonb,
  error_code          text,
  error               text,
  http_status         integer
);
CREATE INDEX IF NOT EXISTS job_open ON fcpi_platform.job (created_at)
  WHERE state IN ('RECEIVED', 'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS job_principal_created ON fcpi_platform.job (principal, created_at DESC);
CREATE INDEX IF NOT EXISTS job_results_expire ON fcpi_platform.job (results_expire_at) WHERE results_expire_at IS NOT NULL;

-- Every state transition, with its time (spec §16.2).
CREATE TABLE IF NOT EXISTS fcpi_platform.job_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_state text,
  to_state   text NOT NULL,
  detail     text
);
CREATE INDEX IF NOT EXISTS job_event_job ON fcpi_platform.job_event (job_id, at);

-- Client idempotency keys, scoped to principal and operation for 24 hours (spec §16.2).
CREATE TABLE IF NOT EXISTS fcpi_platform.idempotency (
  principal    text NOT NULL,
  operation    text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  job_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (principal, operation, key)
);

-- The committed manifest of a job's archived documents: each document is a content-addressed file
-- under the artifact root, written and fsynced before its row commits.
CREATE TABLE IF NOT EXISTS fcpi_platform.job_document (
  job_id  uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  doc_key text NOT NULL,
  sha256  text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes   integer NOT NULL CHECK (bytes > 0),
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, doc_key)
);
CREATE INDEX IF NOT EXISTS job_document_sha256 ON fcpi_platform.job_document (sha256);

-- The ledger's schema version. The gateway reads it at startup and refuses to run against any other
-- (M3's rollback rule: never a binary against a ledger schema it was not written for); a migration
-- that changes the schema raises it in the same transaction.
CREATE TABLE IF NOT EXISTS fcpi_platform.schema_version (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fcpi_platform.schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
-- Version 2 (M5): extraction jobs. A ledger made at version 1 gains the kind in place; the constraint
-- and the version move in one transaction, so the gateway never sees one without the other.
BEGIN;
ALTER TABLE fcpi_platform.job DROP CONSTRAINT IF EXISTS job_kind_check;
ALTER TABLE fcpi_platform.job ADD CONSTRAINT job_kind_check CHECK (kind IN ('crawl', 'batch', 'extract'));
INSERT INTO fcpi_platform.schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
-- Version 3 (M7): four tables, each naming content-addressed files under the artifact root as job_document does, so
-- the archive's sweep keeps what any of them names. The tables and the version move in one transaction.
BEGIN;
-- A capture a scrape returned (a screenshot), stored as an owner-bound artifact served at /platform/v1/artifacts/{id}
-- until it expires (spec §12, §16.1).
CREATE TABLE IF NOT EXISTS fcpi_platform.artifact (
  id          uuid PRIMARY KEY,
  principal   text NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       integer NOT NULL CHECK (bytes > 0),
  mime        text NOT NULL CHECK (mime IN ('image/png')),
  width       integer NOT NULL CHECK (width > 0),
  height      integer NOT NULL CHECK (height > 0),
  truncated   boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_sha256 ON fcpi_platform.artifact (sha256);
CREATE INDEX IF NOT EXISTS artifact_expires ON fcpi_platform.artifact (expires_at);
-- A successful scrape's answer, served again to the same principal for the same request within its freshness (spec
-- §21.3, AC21). key: the request's hash without its cache options.
CREATE TABLE IF NOT EXISTS fcpi_platform.page_cache (
  principal   text NOT NULL,
  key         text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       integer NOT NULL CHECK (bytes > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (principal, key)
);
CREATE INDEX IF NOT EXISTS page_cache_sha256 ON fcpi_platform.page_cache (sha256);
-- The last successful version of a page a principal asked /platform/v1/changes about (spec §31.3): its markdown, and
-- the hash of its normalized text that the next comparison is made against.
CREATE TABLE IF NOT EXISTS fcpi_platform.page_version (
  principal         text NOT NULL,
  key               text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  url               text NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes             integer NOT NULL CHECK (bytes > 0),
  normalized_sha256 text NOT NULL CHECK (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  scraped_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (principal, key)
);
CREATE INDEX IF NOT EXISTS page_version_sha256 ON fcpi_platform.page_version (sha256);
-- The webhook outbox (spec §31.3, AC20): one event per job and type, written in the transaction of the transition
-- that raised it, delivered at least once by the gateway's outbox round, retried within a bound, then kept as DEAD.
CREATE TABLE IF NOT EXISTS fcpi_platform.webhook_event (
  id            uuid PRIMARY KEY,
  job_id        uuid NOT NULL,
  principal     text NOT NULL,
  type          text NOT NULL,
  destination   text NOT NULL,
  body          text NOT NULL,
  state         text NOT NULL CHECK (state IN ('PENDING', 'DELIVERED', 'DEAD')),
  attempts      integer NOT NULL DEFAULT 0,
  next_at       timestamptz NOT NULL DEFAULT now(),
  last_status   integer,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  UNIQUE (job_id, type)
);
CREATE INDEX IF NOT EXISTS webhook_event_due ON fcpi_platform.webhook_event (next_at) WHERE state = 'PENDING';
-- An event's type is one the gateway raises and its attempts never negative, as the other tables constrain their values;
-- dropped and added again, so a ledger already at version 3 gets them too.
ALTER TABLE fcpi_platform.webhook_event DROP CONSTRAINT IF EXISTS webhook_event_type_check, DROP CONSTRAINT IF EXISTS webhook_event_attempts_check;
ALTER TABLE fcpi_platform.webhook_event ADD CONSTRAINT webhook_event_type_check CHECK (type ~ '^(crawl|batch_scrape|extract)\.(started|completed|failed)$'),
  ADD CONSTRAINT webhook_event_attempts_check CHECK (attempts >= 0);
INSERT INTO fcpi_platform.schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fcpi_gateway') THEN
    CREATE ROLE fcpi_gateway LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  -- The reconciler's one read of NuQ runs as this role: it can log in nowhere and may only read the
  -- two tables that hold job data, so the function below grants nothing beyond that read.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fcpi_nuq_reader') THEN
    CREATE ROLE fcpi_nuq_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA nuq TO fcpi_nuq_reader;
GRANT SELECT ON nuq.queue_scrape, nuq.queue_scrape_backlog TO fcpi_nuq_reader;

-- The upstream groups (crawl or batch ids) whose jobs carry a submission marker: the crawl's kickoff
-- and page jobs hold it in data.origin, a batch's page jobs in data.scrapeOptions.origin (upstream
-- 7666c1f9 apps/api/src/controllers/v2/crawl.ts and batch-scrape.ts).
CREATE OR REPLACE FUNCTION fcpi_platform.upstream_groups_for_marker(marker text)
RETURNS TABLE (group_id uuid, first_seen timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT j.group_id, min(j.created_at)
    FROM (SELECT q.group_id, q.created_at, q.data FROM nuq.queue_scrape q
          UNION ALL
          SELECT b.group_id, b.created_at, b.data FROM nuq.queue_scrape_backlog b) j
   WHERE j.group_id IS NOT NULL
     AND (j.data->>'origin' = marker OR j.data->'scrapeOptions'->>'origin' = marker)
   GROUP BY j.group_id
   ORDER BY 2
$$;
ALTER FUNCTION fcpi_platform.upstream_groups_for_marker(text) OWNER TO fcpi_nuq_reader;
REVOKE ALL ON FUNCTION fcpi_platform.upstream_groups_for_marker(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fcpi_platform.upstream_groups_for_marker(text) TO fcpi_gateway;

REVOKE ALL ON SCHEMA fcpi_platform FROM PUBLIC;
GRANT USAGE ON SCHEMA fcpi_platform TO fcpi_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON fcpi_platform.job, fcpi_platform.job_event, fcpi_platform.idempotency, fcpi_platform.job_document,
  fcpi_platform.artifact, fcpi_platform.page_cache, fcpi_platform.page_version, fcpi_platform.webhook_event TO fcpi_gateway;
GRANT SELECT ON fcpi_platform.schema_version TO fcpi_gateway;
-- The gateway reads nothing of NuQ's or the retrieval service's directly.
REVOKE ALL ON SCHEMA nuq FROM fcpi_gateway;
REVOKE ALL ON SCHEMA fcpi_retrieval FROM fcpi_gateway;
