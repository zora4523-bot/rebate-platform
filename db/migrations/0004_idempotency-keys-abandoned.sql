-- Up Migration
-- Support abandoned idempotency keys (规划/04 §3.2; BR-ID-10 敏感操作的幂等键).
-- Recovery: restore from backup; do not discard abandoned keys or invent request hashes.
-- Existing rows must satisfy the checks; invalid data makes the migration roll back.

ALTER TABLE app.idempotency_keys
  ALTER COLUMN request_hash DROP NOT NULL,
  ADD CONSTRAINT idempotency_keys_status_check
    CHECK (status IN ('processing', 'completed', 'abandoned')),
  ADD CONSTRAINT idempotency_keys_request_data_check
    CHECK (
      (status = 'abandoned' AND request_hash IS NULL AND response IS NULL)
      OR (status IN ('processing', 'completed') AND request_hash IS NOT NULL)
    );
