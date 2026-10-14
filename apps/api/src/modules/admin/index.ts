// Public surface of the admin module. Other modules depend on the platform AUDIT_PORT, not on
// this file (admin depends on every module; importing admin would close a cycle).
export { AdminModule, TOTP_REPLAY_STORE } from './admin.module.ts';
export { createAuditWriter } from './infra/audit-writer.ts';
export {
  AUDIT_REDACTED,
  AUDIT_SENSITIVE_FRAGMENTS,
  redactSnapshot,
} from './infra/audit-redaction.ts';
export type { AdminAuditInput, AuditWriterDeps } from './infra/audit-writer.ts';
export {
  createTotpVerifier,
  totpSecretContext,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
} from './domain/totp.ts';
export type {
  TotpAccount,
  TotpClaim,
  TotpReplayStore,
  TotpRequest,
  TotpVerifier,
} from './domain/totp.ts';
export { createPgTotpReplayStore } from './infra/totp-replay-pg.ts';
// Test double only; production uses createPgTotpReplayStore.
export { createMemoryTotpReplayStore } from './infra/totp-replay-memory.ts';
export { createSuperVerifier } from './application/verify-super.ts';
export type { SuperVerifier } from './application/verify-super.ts';
// Admin console authentication (F1-06k): the admin entry's module, its request check and the
// CORS policy that bootstrap installs (app.module and bootstrap only).
export { AdminAuthModule } from './admin-auth.module.ts';
export type { AdminHttpPolicy } from './admin-auth.module.ts';
export { ADMIN_CHECK, ADMIN_HTTP_POLICY } from './application/tokens.ts';
export { isAdminCheck } from './application/admin-check.ts';
export { getAdminPermissionCatalog } from './domain/permission-catalog.ts';
export type { AdminPermissionDefinition, AdminStepUpTier } from './domain/permission-catalog.ts';
export {
  createAdminPermissionGuard,
  createAdminStepUpTokens,
} from './application/permission-guard.ts';
export type {
  AdminBusinessResponse,
  AdminPermissionGuard,
  AdminPermissionPrincipal,
  AdminPermissionRequest,
  AdminStepUpBinding,
  AdminStepUpGrant,
  AdminStepUpTokens,
} from './application/permission-guard.ts';
