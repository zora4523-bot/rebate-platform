-- Up Migration
-- Business tables live in schema `app`; `public` only holds `pgmigrations` and the `vector`
-- extension. Runs as couli_migrator, which therefore owns the schema (ADR-0001 §4.2 #8).
-- Compatibility: additive. Recovery: restore from backup (no down migrations in this repo).

CREATE SCHEMA app;

-- USAGE only: no role except the owner may create objects in `app`.
GRANT USAGE ON SCHEMA app TO couli_app, couli_payout, couli_readonly, couli_maint;
