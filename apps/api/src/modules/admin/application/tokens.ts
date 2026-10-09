// Nest injection tokens of the admin console authentication (F1-06k). Admin-internal except
// ADMIN_CHECK and ADMIN_HTTP_POLICY, which app.module and bootstrap read through ../index.ts.

/** AdminAuthService (./admin-login.ts). */
export const ADMIN_AUTH = Symbol('ADMIN_AUTH');
/** The admin entry's RequestCheck (./admin-check.ts). */
export const ADMIN_CHECK = Symbol('ADMIN_CHECK');
/** AdminHttpPolicy: the console CORS origin and the whitelist predicate, for bootstrap. */
export const ADMIN_HTTP_POLICY = Symbol('ADMIN_HTTP_POLICY');
/** AdminStepUpService (./admin-step-up.ts): step-up and me/permissions (F1-06l). */
export const ADMIN_STEP_UP = Symbol('ADMIN_STEP_UP');
