-- =============================================================================
-- Migration 0002: UUID primary-key defaults
-- =============================================================================
-- The initial schema (0001) declared every UUID primary key as
-- `UUID PRIMARY KEY` WITHOUT a column default. The repository layer
-- (`buildInsert`) intentionally OMITS an undefined `id` so the database can
-- fill it in (see backend/src/db/types.ts: "DEFAULTed columns (ids, ...) are
-- optional on the insert input types ... let Postgres fill them in"). Without a
-- default, an omitted id is inserted as NULL and violates the NOT NULL primary
-- key — which surfaced at runtime when the Network Guard appended an
-- `environment_checks` row at startup.
--
-- This migration adds the missing `DEFAULT gen_random_uuid()` to every UUID
-- primary key so callers may omit `id`. `gen_random_uuid()` is built into
-- PostgreSQL 13+ (pgcrypto merged into core), so no extension is required.
--
-- `walrus_blobs` is intentionally excluded: its primary key is `blob_id TEXT`,
-- always supplied by the caller (the Walrus blob id), not a generated UUID.
-- =============================================================================

ALTER TABLE markets            ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE policies           ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE risk_snapshots     ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE incidents          ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE actions            ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE environment_checks ALTER COLUMN id SET DEFAULT gen_random_uuid();
