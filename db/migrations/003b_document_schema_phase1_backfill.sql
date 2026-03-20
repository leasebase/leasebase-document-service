-- document_service: Phase 1 backfill — legacy document status values
--
-- Companion to 003_document_schema_phase1.sql.
-- Must run AFTER migration 003 commits the new enum values (FULLY_EXECUTED,
-- VERIFIED_EXTERNAL). Running in a separate migration guarantees those values
-- are committed before this UPDATE references them, satisfying PostgreSQL's
-- constraint: "New enum values must be committed before they can be used."
--
-- Idempotent: rows not matching the source status are unaffected.
-- Safe to re-run: existing FULLY_EXECUTED/VERIFIED_EXTERNAL rows are unchanged.
--
-- Backfill:
--   EXECUTED           → FULLY_EXECUTED    (semantically equivalent Phase 1 name)
--   CONFIRMED_EXTERNAL → VERIFIED_EXTERNAL (semantically equivalent Phase 1 name)
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/003b_document_schema_phase1_backfill.sql

SET search_path TO document_service, public;

UPDATE document_service.documents
SET status = 'FULLY_EXECUTED'::document_service.document_status_enum
WHERE status = 'EXECUTED'::document_service.document_status_enum;

UPDATE document_service.documents
SET status = 'VERIFIED_EXTERNAL'::document_service.document_status_enum
WHERE status = 'CONFIRMED_EXTERNAL'::document_service.document_status_enum;
