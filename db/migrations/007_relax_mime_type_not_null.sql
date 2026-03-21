-- Migration: 007_relax_mime_type_not_null
-- Relaxes NOT NULL constraint on legacy mime_type column that blocks Phase 1 upload-url.
--
-- Root cause: 001_init.sql created documents.mime_type TEXT NOT NULL.
-- Phase 1 upload-url stores mime_type only in document_versions, not in documents.
-- The Phase 1 INSERT omits mime_type, causing a NOT NULL violation → HTTP 500.
--
-- This is the same class of bug as 006_relax_legacy_not_null.sql (which fixed
-- name and s3_key) but mime_type was missed in that pass.
--
-- Fix: DROP NOT NULL on mime_type so Phase 1 inserts succeed.
-- Existing rows retain their values.
-- Idempotent: ALTER COLUMN DROP NOT NULL is safe to re-run.
--
-- Run as leasebase_admin:
--   psql -h <host> -U leasebase_admin -d leasebase -f db/migrations/007_relax_mime_type_not_null.sql

SET search_path TO document_service, public;

ALTER TABLE document_service.documents ALTER COLUMN mime_type DROP NOT NULL;
