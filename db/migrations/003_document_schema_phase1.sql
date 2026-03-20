-- document_service: Phase 1 schema normalization
-- Idempotent: safe to re-run (IF NOT EXISTS / DO $$ blocks / ALTER ... IF NOT EXISTS).
--
-- migrate:no-transaction
-- This migration uses DO $$ anonymous blocks AND ALTER TYPE ... ADD VALUE which
-- cannot run inside a BEGIN/EXCEPTION/END subtransaction. The migration runner
-- must use the no-transaction path (no SAVEPOINT wrapper) for correct execution.
--
-- Changes:
--   1. Extend document_status_enum with Phase 1 vocabulary
--   2. Add new columns to documents table (category, title, description, current_version_id, archived_at)
--   3. Create document_versions table
--   4. Create document_audit_events table
--   5. Add indexes
--
-- NOTE: The UPDATE backfill for EXECUTED→FULLY_EXECUTED / CONFIRMED_EXTERNAL→VERIFIED_EXTERNAL
-- is in the companion migration 003b_document_schema_phase1_backfill.sql.
-- It must run AFTER this migration commits the new enum values.
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/003_document_schema_phase1.sql

SET search_path TO document_service, public;

-- ── 1. Extend document_status_enum with Phase 1 values ──────────────────────
-- ADD VALUE is NOT transactional in PostgreSQL, but is idempotent via
-- the IF NOT EXISTS guard added in PG 9.6+.

ALTER TYPE document_service.document_status_enum ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE document_service.document_status_enum ADD VALUE IF NOT EXISTS 'PENDING_TENANT_SIGNATURE';
ALTER TYPE document_service.document_status_enum ADD VALUE IF NOT EXISTS 'FULLY_EXECUTED';
ALTER TYPE document_service.document_status_enum ADD VALUE IF NOT EXISTS 'VERIFIED_EXTERNAL';
ALTER TYPE document_service.document_status_enum ADD VALUE IF NOT EXISTS 'ARCHIVED';

-- ── 2. Add new columns to documents ───────────────────────────────────────────────

-- category: document classification (e.g. LEASE_AGREEMENT, MOVE_IN_CHECKLIST)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'category'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN category TEXT NOT NULL DEFAULT 'OWNER_UPLOAD';
  END IF;
END $$;

-- title: human-readable document title
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'title'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN title TEXT NOT NULL DEFAULT '';
    -- Back-fill: use name column value as title for existing rows
    UPDATE document_service.documents SET title = name WHERE title = '';
  END IF;
END $$;

-- description: optional free-form description
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'description'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN description TEXT;
  END IF;
END $$;

-- current_version_id: foreign key to active document_version (set after upload-complete)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'current_version_id'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN current_version_id TEXT;
  END IF;
END $$;

-- archived_at: soft-delete timestamp
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'archived_at'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN archived_at TIMESTAMPTZ;
  END IF;
END $$;

-- ── 4. New indexes for documents ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_documents_org_category
  ON document_service.documents(organization_id, category);

CREATE INDEX IF NOT EXISTS idx_documents_org_status
  ON document_service.documents(organization_id, status);

-- ── 5. Create document_versions ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.document_versions (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id          TEXT NOT NULL
                         REFERENCES document_service.documents(id) ON DELETE CASCADE,
  version_number       INT  NOT NULL,
  storage_bucket       TEXT NOT NULL,
  storage_key          TEXT NOT NULL,
  file_name            TEXT NOT NULL,
  original_file_name   TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  size_bytes           BIGINT,
  sha256               TEXT,
  uploaded_by_user_id  TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_versions_unique_version UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_doc_versions_document_id
  ON document_service.document_versions(document_id);

-- ── 6. Create document_audit_events ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.document_audit_events (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id    TEXT NOT NULL
                   REFERENCES document_service.documents(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  actor_user_id  TEXT,
  actor_role     TEXT,
  metadata_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_audit_document_id
  ON document_service.document_audit_events(document_id);
