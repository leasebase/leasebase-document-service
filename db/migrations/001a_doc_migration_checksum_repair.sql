-- document_service: one-time checksum repair for migrations 002 and 003
--
-- CONTEXT:
--   Migrations 002 and 003 had '-- migrate:no-transaction' directives added
--   to their file headers to fix a DO-block execution issue. This changed their
--   SHA-256 checksums in schema_migrations, causing MIGRATION_MISMATCH failures.
--
--   This repair migration runs BEFORE the 002/003 checksum check and safely
--   updates any stored old checksums to the new values.
--
--   Idempotent:
--   - If the DB has old checksums (5698.../4166...) → updates to new checksums
--   - If the DB already has new checksums (6248.../8f07b...) → no change
--   - If the DB has no rows for 002/003 (fresh DB) → no change
--
-- Old checksums (before no-transaction directive was added):
--   002: 5698295d5a85333c71e9d4c20392a03e0d7bcffaede55da87362d386a379b3be
--   003: 4166163b30e0e4d7b0b20c29c666c1f961b514226c3f117ca6ac26bbe5d135af
--
-- New checksums (after no-transaction directive was added):
--   002: 6248089d27dc5c46113d3e473ff9d5238c61ae515303a0be3d9713743cfed0cb
--   003: 8f07b00ec845fd062756b0cbdfdf570c1ff52428133019c852b80eed4ea18bcc

UPDATE public.schema_migrations
SET checksum = '6248089d27dc5c46113d3e473ff9d5238c61ae515303a0be3d9713743cfed0cb'
WHERE service  = 'document-service'
  AND migration = '002_document_status.sql'
  AND checksum  = '5698295d5a85333c71e9d4c20392a03e0d7bcffaede55da87362d386a379b3be';

UPDATE public.schema_migrations
SET checksum = '8f07b00ec845fd062756b0cbdfdf570c1ff52428133019c852b80eed4ea18bcc'
WHERE service  = 'document-service'
  AND migration = '003_document_schema_phase1.sql'
  AND checksum  = '4166163b30e0e4d7b0b20c29c666c1f961b514226c3f117ca6ac26bbe5d135af';
