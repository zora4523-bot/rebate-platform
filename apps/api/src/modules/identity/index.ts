// Public surface of the identity module. Other modules import only from this file.
// Stages ⑧ ⑨ (BR-ID-01 identity level, B1-02za): app.module hands IDENTITY_LEVEL_CHECKS' guard and
// post-miss check to RiskModule, and assembles the real-name status port.
export {
  IDENTITY_LEVEL_CHECKS,
  identityLevelRefusal,
  createIdentityLevelChecks,
  createDefaultRealnameStatusReader,
} from './application/identity-level.ts';
export type {
  RealnameStatus,
  RealnameStatusReader,
  IdentityLevelInput,
  IdentityLevelGuard,
  IdentityLevelChecks,
  IdentityLevelOptions,
} from './application/identity-level.ts';
export { createUserLevelReader } from './ports/user-level.ts';
export type {
  UserLevel,
  UserLevelSubject,
  UserLevelReader,
  UserLevelReaderOptions,
} from './ports/user-level.ts';
export { createAiConsentReader } from './ports/ai-consent.ts';
export type {
  AiConsentSubject,
  AiConsentVerdict,
  AiConsentReader,
  AiConsentReaderOptions,
} from './ports/ai-consent.ts';
export { createSameDeviceLoginReader } from './ports/same-device-logins.ts';
export {
  createIdentityViewerContext,
  createIdentityCallerContext,
  createIdentityAttrCodeReader,
} from './ports/request-context.ts';
export type {
  IdentityRequest,
  IdentityContext,
  IdentityAttrCodeReader,
} from './ports/request-context.ts';
export { revokeSessionsByUser, revokeSessionsByDevice } from './application/revoke-sessions.ts';
export type { AfterSessionsRevoked, SessionRevokeReason } from './application/revoke-sessions.ts';
export { IdentityModule } from './identity.module.ts';
// The admin entry's console routes of identity (F1-07a: the audited phone reveal).
export { IdentityAdminModule } from './identity-admin.module.ts';
export { ME_READ_PORTS } from './application/tokens.ts';
export type { MeReadPorts, MeUnionBindingStatus } from './application/me.ts';
export type { InviteBackfillActivityPort, MeSubject } from './ports/invite-backfill-activity.ts';
export { createInviteBackfillActivityReader } from './infra/me-reads.ts';
export type {
  AssembledRevokeByDevice,
  AssembledRevokeByUser,
  IdentityConfigReader,
  IdentityModuleOptions,
} from './identity.module.ts';
// B1-12b: the push token port app.module builds from notification's commands.
export type { SessionPushTokens } from './application/push-tokens.ts';
export type { AccountAssetsPort, AccountRiskPort } from './application/bind-phone.ts';
// Stage ⑫ step-up check (BR-ID-08, B1-02y): app.module hands the check to RiskModule; the handlers
// of the four x-step-up operations run their idempotent call through withStepUp.
export { STEP_UP_CHECK, createStepUpCheck, withStepUp } from './application/step-up-verify.ts';
export type { StepUpCheckOptions, StepUpHttpRequest } from './application/step-up-verify.ts';
// The token stages ② ③ (BR-ID-01) for the api entry's request check plan (app.module).
export { TOKEN_CHECK } from './application/tokens.ts';
// Bootstrap's route guard: is a plan's check identity's token check (BR-ID-01 ②)?
export { isTokenCheck } from './application/access-tokens.ts';
// BR-ID-05 细则「手机号规范化」: every module normalises a phone number with this function first.
export { normalize_phone } from './domain/normalize-phone.ts';
export type { NormalizedPhone } from './domain/normalize-phone.ts';
export type { SmsConfigReader } from './application/sms-codes.ts';
export type { MinimumVersionReader } from './application/session-scope.ts';
// Account creation core (B1-02i): SMS login, third-party first login and the landing page reuse it.
export {
  createRegistrationService,
  createDefaultInviteCodeFilter,
  countDeviceRegistrations,
  registrationConstants,
  snapshotRegistrationConfig,
  REGISTRATION_CONFIG_KEYS,
  DEFAULT_AVATAR,
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from './application/registration.ts';
export type {
  RegisterMethod,
  RegistrationCommand,
  RegistrationOptions,
  RegistrationResult,
  RegistrationService,
  RegistrationConstants,
  DeviceLimitContext,
  DeviceRegistrationRecord,
  InviteBindResult,
  SensitiveWords,
} from './application/registration.ts';
export { createSmsLoginService, LOGIN_LOGS_DEVICE_ID_CONTEXT } from './application/sms-login.ts';
export type {
  FirstAppLoginReview,
  SmsLoginCommand,
  SmsLoginOptions,
  SmsLoginResult,
  SmsLoginService,
} from './application/sms-login.ts';
// The process SMS sender and its Nest token (the admin entry's sms step-up tier, F1-06l).
export { createSmsSender, smsSenderToken } from './infra/fake-sms.ts';
export { createThirdPartyIdentity } from './infra/fake-third-party-identity.ts';
export { projectAdminUser } from './application/admin-user-view.ts';
export type { AdminUserViewReader, AdminUserViewSource } from './application/admin-user-view.ts';
