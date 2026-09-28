-- M8's rehearsal candidate (scripts/m8/pi-rehearsal.sh): a ledger migration to schema version 4, applied only to the
-- isolated restored copy, never to production. It adds a table and raises the version in one transaction, as a real
-- migration does, so the gateway built for version 3 refuses the migrated ledger (M3's rule) and the rollback has to
-- restore the pre-migration data with the image, not the image alone.
BEGIN;
CREATE TABLE fcpi_platform.m8_rehearsal (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO fcpi_platform.m8_rehearsal VALUES (1, 'the candidate migration ran');
INSERT INTO fcpi_platform.schema_version (version) VALUES (4);
COMMIT;
