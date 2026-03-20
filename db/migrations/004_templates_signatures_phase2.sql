-- document_service: Phase 2 schema — Templates, Generated Documents, Signature Readiness
-- Idempotent: safe to re-run (IF NOT EXISTS / DO $$ blocks).
--
-- Changes:
--   1. document_templates          — reusable template definitions per org
--   2. document_template_versions  — versioned storage for template files
--   3. document_template_variables — typed variable definitions per template version
--   4. generated_documents         — links a document back to the template+version that generated it
--   5. signature_requests          — signature readiness workflow (provider-agnostic)
--   6. signature_request_signers   — per-signer status within a request
--   7. signature_request_events    — audit trail for signature lifecycle
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/004_templates_signatures_phase2.sql

SET search_path TO document_service, public;

-- ── 1. document_templates ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.document_templates (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id     TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'LEASE_AGREEMENT',
  name                TEXT NOT NULL,
  description         TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_org
  ON document_service.document_templates(organization_id);

CREATE INDEX IF NOT EXISTS idx_doc_templates_org_active
  ON document_service.document_templates(organization_id, is_active);

-- ── 2. document_template_versions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.document_template_versions (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_id         TEXT NOT NULL
                        REFERENCES document_service.document_templates(id) ON DELETE CASCADE,
  version_number      INT  NOT NULL,
  storage_bucket      TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  source_format       TEXT NOT NULL DEFAULT 'PDF',   -- PDF, DOCX, HTML
  content_text        TEXT,                           -- in-DB template body (optional)
  created_by_user_id  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT doc_template_versions_unique UNIQUE (template_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_doc_template_versions_template_id
  ON document_service.document_template_versions(template_id);

-- ── 3. document_template_variables ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.document_template_variables (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_version_id  TEXT NOT NULL
                         REFERENCES document_service.document_template_versions(id) ON DELETE CASCADE,
  variable_key         TEXT NOT NULL,
  label                TEXT NOT NULL,
  data_type            TEXT NOT NULL DEFAULT 'STRING',  -- STRING, NUMBER, DATE, BOOLEAN, CURRENCY, TEXT
  required             BOOLEAN NOT NULL DEFAULT false,
  default_value_json   TEXT,
  sort_order           INT  NOT NULL DEFAULT 0,
  CONSTRAINT doc_template_vars_unique_key UNIQUE (template_version_id, variable_key)
);

CREATE INDEX IF NOT EXISTS idx_doc_template_vars_version_id
  ON document_service.document_template_variables(template_version_id);

-- ── 4. generated_documents ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.generated_documents (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id           TEXT NOT NULL
                          REFERENCES document_service.documents(id) ON DELETE CASCADE,
  template_version_id   TEXT NOT NULL
                          REFERENCES document_service.document_template_versions(id),
  lease_id              TEXT NOT NULL,
  generation_input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id    TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_docs_document_id
  ON document_service.generated_documents(document_id);

CREATE INDEX IF NOT EXISTS idx_generated_docs_lease_id
  ON document_service.generated_documents(lease_id);

-- ── 5. signature_requests ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.signature_requests (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id          TEXT NOT NULL
                         REFERENCES document_service.documents(id) ON DELETE CASCADE,
  organization_id      TEXT NOT NULL,
  provider             TEXT NOT NULL DEFAULT 'MANUAL',
  provider_request_id  TEXT,
  status               TEXT NOT NULL DEFAULT 'DRAFT',
  -- DRAFT, REQUESTED, PARTIALLY_SIGNED, COMPLETED, CANCELLED, FAILED
  requested_by_user_id TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sig_requests_document_id
  ON document_service.signature_requests(document_id);

CREATE INDEX IF NOT EXISTS idx_sig_requests_org_status
  ON document_service.signature_requests(organization_id, status);

-- ── 6. signature_request_signers ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.signature_request_signers (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signature_request_id TEXT NOT NULL
                         REFERENCES document_service.signature_requests(id) ON DELETE CASCADE,
  signer_type          TEXT NOT NULL DEFAULT 'TENANT',  -- OWNER, TENANT, WITNESS
  user_id              TEXT NOT NULL,
  email                TEXT,
  display_name         TEXT,
  routing_order        INT  NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING, VIEWED, SIGNED, DECLINED, FAILED
  signed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sig_request_signers_request_id
  ON document_service.signature_request_signers(signature_request_id);

-- ── 7. signature_request_events ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_service.signature_request_events (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  signature_request_id TEXT NOT NULL
                         REFERENCES document_service.signature_requests(id) ON DELETE CASCADE,
  event_type           TEXT NOT NULL,
  payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sig_request_events_request_id
  ON document_service.signature_request_events(signature_request_id);
