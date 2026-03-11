-- document_service schema initialization
-- Idempotent: safe to re-run on existing databases (IF NOT EXISTS guards).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/001_init.sql

CREATE SCHEMA IF NOT EXISTS document_service;
SET search_path TO document_service, public;

-- ── documents ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id     TEXT NOT NULL,
  related_type        TEXT NOT NULL,
  related_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  s3_key              TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_org_id
  ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_org_related
  ON documents(organization_id, related_type, related_id);
