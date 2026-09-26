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
