-- Up Migration
-- Admin login state (BR-ID-34: 连续失败 5 次锁定 30 分钟; 首次登录强制改密码, 负责人 2026-10-06;
-- 细则「动态码错误」counts toward the same lockout; 规划/04 §3.2 row admin_users, column names
-- chosen by the implementer; SPEC_REF b3924b1; ADR-0001 §4). Task F1-06o.
-- Compatibility: additive. Three new columns on app.admin_users; the two NOT NULL columns carry
-- constant defaults, so existing rows (the super admin created by the F1-06c bootstrap command,
-- whose password the owner set personally) read password_must_change = false and
-- failed_login_count = 0 without a rewrite, and locked_until is NULL. Writers that omit the new
-- columns stay valid. Nothing in 0016 changes. Recovery: restore from backup; no down migration.
--
-- password_must_change: true while the account still uses the one-time initial password a super
-- admin generated for it; the first login must replace it (different from the initial password)
-- before TOTP binding, and only then is admin_token issued. Set and cleared by the admin module.
-- failed_login_count: consecutive failed login attempts; wrong passwords and wrong TOTP codes share
-- this one counter (BR-ID-34 细则). Never negative (named CHECK). The threshold (5) and the reset
-- policy belong to the admin module, not to SQL.
-- locked_until: end of the current lockout; NULL means not locked. The value comes from the
-- injected Clock (now + 30 minutes) written by the admin module, so there is no SQL default
-- (db/AGENTS.md rule 6). No trigger is added (db/AGENTS.md rule 8).
--
-- Grants: couli_app gets column-level UPDATE on the three new columns; its existing table-level
-- SELECT and INSERT from 0016 already cover them. couli_readonly gets nothing on these columns
-- (the admin console reads login state through the primary with couli_app), and no other role
-- (couli_payout, couli_maint) gets any privilege on them.
--
-- Timeouts: ADD COLUMN with a constant default is a catalog-only change in PostgreSQL 11+, and
-- the CHECK is validated against a table of a handful of admin accounts, under the ACCESS
-- EXCLUSIVE lock the ALTER already holds. 5s lock wait so a blocked deploy fails fast instead
-- of queueing login traffic behind it; 30s overall as a ceiling for catalog changes plus the
-- near-empty constraint scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.admin_users
  ADD COLUMN password_must_change boolean NOT NULL DEFAULT false,
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0
    CONSTRAINT admin_users_failed_login_count_check CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz;

GRANT UPDATE (password_must_change, failed_login_count, locked_until)
  ON app.admin_users TO couli_app;
