-- document_service: add durable status and updated_at to documents table
-- This migration introduces a machine-checkable lifecycle status for lease documents,
-- enabling the lease activation gate to verify documentation sufficiency.
--
-- Supported status values:
--   UPLOADED           - document has been stored but not yet reviewed/confirmed
--   EXECUTED           - document has been signed/executed through the platform
--   CONFIRMED_EXTERNAL - owner has confirmed an externally-executed document is on file
--
-- Idempotent: safe to re-run (IF NOT EXISTS and existence-check guards).
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/002_document_status.sql

SET search_path TO document_service, public;

-- ── 1. Add document_status ENUM ──────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_status_enum'
                   AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'document_service')) THEN
    CREATE TYPE document_service.document_status_enum AS ENUM (
      'UPLOADED',
      'EXECUTED',
      'CONFIRMED_EXTERNAL'
    );
  END IF;
END $$;

-- ── 2. Add status column (default UPLOADED for existing rows) ─────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'status'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN status document_service.document_status_enum NOT NULL DEFAULT 'UPLOADED';
  END IF;
END $$;

-- ── 3. Add updated_at column ──────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'documents'
      AND column_name  = 'updated_at'
  ) THEN
    ALTER TABLE document_service.documents
      ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    -- Back-fill existing rows to match created_at
    UPDATE document_service.documents SET updated_at = created_at WHERE updated_at = NOW();
  END IF;
END $$;

-- ── 4. Index for efficient lease-document lookup (used by activation gate) ────

CREATE INDEX IF NOT EXISTS idx_documents_lease_status
  ON document_service.documents(related_id, status)
  WHERE related_type = 'LEASE';
