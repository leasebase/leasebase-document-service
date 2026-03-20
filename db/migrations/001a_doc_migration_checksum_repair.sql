-- document_service: one-time checksum repair for migrations 002 and 003
--
-- CONTEXT:
--   Migration 002 had '-- migrate:no-transaction' added, changing its checksum.
--   Migration 003 had its UPDATE backfill moved to 003b, changing its checksum.
--   This repair migration updates any stored old checksums to the current values.
--
--   Idempotent: WHERE clause guards ensure no-op if checksum not found.
--
-- Migration 002 checksum history:
--   original:         5698295d5a85333c71e9d4c20392a03e0d7bcffaede55da87362d386a379b3be
--   +no-tx directive: 6248089d27dc5c46113d3e473ff9d5238c61ae515303a0be3d9713743cfed0cb  (current)
--
-- Migration 003 checksum history:
--   original:         4166163b30e0e4d7b0b20c29c666c1f961b514226c3f117ca6ac26bbe5d135af
--   +no-tx directive: 8f07b00ec845fd062756b0cbdfdf570c1ff52428133019c852b80eed4ea18bcc
--   +no-tx +backfill split (current): c77eb574edb13a5cb742a4e1d664c68a64b798b980e146ca04d62b2ffddb9bf3

-- Repair 002: original → current
UPDATE public.schema_migrations
SET checksum = '6248089d27dc5c46113d3e473ff9d5238c61ae515303a0be3d9713743cfed0cb'
WHERE service  = 'document-service'
  AND migration = '002_document_status.sql'
  AND checksum  = '5698295d5a85333c71e9d4c20392a03e0d7bcffaede55da87362d386a379b3be';

-- Repair 003: original → current
UPDATE public.schema_migrations
SET checksum = 'c77eb574edb13a5cb742a4e1d664c68a64b798b980e146ca04d62b2ffddb9bf3'
WHERE service  = 'document-service'
  AND migration = '003_document_schema_phase1.sql'
  AND checksum  = '4166163b30e0e4d7b0b20c29c666c1f961b514226c3f117ca6ac26bbe5d135af';

-- Repair 003: intermediate (+no-tx directive) → current (+no-tx +backfill split)
UPDATE public.schema_migrations
SET checksum = 'c77eb574edb13a5cb742a4e1d664c68a64b798b980e146ca04d62b2ffddb9bf3'
WHERE service  = 'document-service'
  AND migration = '003_document_schema_phase1.sql'
  AND checksum  = '8f07b00ec845fd062756b0cbdfdf570c1ff52428133019c852b80eed4ea18bcc';
