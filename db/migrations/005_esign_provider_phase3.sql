-- document_service: Phase 3 — E-Sign Provider Integration
-- Idempotent: safe to re-run (DO $$ / IF NOT EXISTS guards).
--
-- Changes:
--   1. signature_request_signers: add provider_signer_id (per-signer ID from provider)
--                                     sign_url (signing URL for tenant redirect flow)
--   2. signature_request_events: add provider_event_id (for idempotent webhook processing)
--                                unique index on provider_event_id
--   3. signature_requests: add index on (provider, provider_request_id) for fast webhook lookup
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/005_esign_provider_phase3.sql

SET search_path TO document_service, public;

-- ── 1. signature_request_signers: provider_signer_id ─────────────────────────
-- Per-signer identifier from the e-sign provider (e.g. HelloSign signature_id).
-- Used to correlate webhook events to internal signer rows.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'signature_request_signers'
      AND column_name  = 'provider_signer_id'
  ) THEN
    ALTER TABLE document_service.signature_request_signers
      ADD COLUMN provider_signer_id TEXT;
  END IF;
END $$;

-- ── 2. signature_request_signers: sign_url ────────────────────────────────────
-- The signing URL returned per-signer by the provider (for redirect/embedded flow).
-- May be refreshed when tenant requests signing URL via the API.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'signature_request_signers'
      AND column_name  = 'sign_url'
  ) THEN
    ALTER TABLE document_service.signature_request_signers
      ADD COLUMN sign_url TEXT;
  END IF;
END $$;

-- ── 3. signature_request_events: provider_event_id ───────────────────────────
-- Provider-assigned unique identifier for each webhook event.
-- Used for idempotent webhook processing (safe to re-deliver).

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'document_service'
      AND table_name   = 'signature_request_events'
      AND column_name  = 'provider_event_id'
  ) THEN
    ALTER TABLE document_service.signature_request_events
      ADD COLUMN provider_event_id TEXT;
  END IF;
END $$;

-- Unique partial index for idempotent webhook dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_sig_events_provider_event_id
  ON document_service.signature_request_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- ── 4. signature_requests: fast lookup by provider_request_id ─────────────────
-- Provider-assigned signature request ID stored in signature_requests.provider_request_id
-- (column already exists from Phase 2). Add index for webhook dispatch.

CREATE INDEX IF NOT EXISTS idx_sig_requests_provider_request_id
  ON document_service.signature_requests(provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
