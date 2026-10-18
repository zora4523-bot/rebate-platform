-- Up Migration
-- consent_records accepts the consent type clipboard_auto_import (consent to the clipboard
-- auto-import feature), added to contracts/enums/identity.yaml consent_type. Task CT-15s.
-- Compatibility: widening only. consent_records_type_check gains the value clipboard_auto_import;
-- the six existing values stay valid, existing rows are not touched. No other constraint, column
-- or table changes (consent_records_channel_check, consent_records_labor_agreement_check and the
-- subject checks stay as they are); no new column, so no grant changes.
-- Recovery: restore from backup; no down migration. (Narrowing back would first need every
-- clipboard_auto_import row removed.)
--
-- Timeouts: DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on consent_records; 5s lock wait
-- so a blocked deploy fails fast instead of queueing consent writes behind it, 60s overall as a
-- ceiling for the CHECK scan of a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.consent_records DROP CONSTRAINT consent_records_type_check;

-- The new CHECK is strictly wider than the one it replaces (same values plus
-- clipboard_auto_import), so every existing row satisfies it; the table holds no real rows before
-- launch and the scan runs inside the ACCESS EXCLUSIVE lock taken just above, so NOT VALID +
-- VALIDATE would gain nothing.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.consent_records ADD CONSTRAINT consent_records_type_check
  CHECK (
    type IN (
      'privacy', 'agreement', 'ai_third_party', 'id_verification', 'personalization',
      'labor_agreement', 'clipboard_auto_import'
    )
  );
