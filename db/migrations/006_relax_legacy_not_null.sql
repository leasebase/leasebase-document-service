-- Migration: 006_relax_legacy_not_null
-- Relaxes NOT NULL constraints on legacy columns that block Phase 1 upload-url flow.
--
-- Root cause: 001_init.sql created documents.name TEXT NOT NULL and documents.s3_key TEXT NOT NULL.
-- Phase 1 upload-url (003) introduced title + document_versions.storage_key as replacements,
-- but never relaxed the original NOT NULL constraints. The Phase 1 INSERT omits name and s3_key,
-- causing a NOT NULL violation → HTTP 500 on POST /upload-url.
--
-- Fix: DROP NOT NULL on name and s3_key so Phase 1 inserts succeed.
-- Existing rows retain their values (backfill not needed).
-- Idempotent: ALTER COLUMN DROP NOT NULL is safe to re-run.
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/006_relax_legacy_not_null.sql

SET search_path TO document_service, public;

ALTER TABLE document_service.documents ALTER COLUMN name DROP NOT NULL;
ALTER TABLE document_service.documents ALTER COLUMN s3_key DROP NOT NULL;
