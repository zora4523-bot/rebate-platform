// Public surface of the risk module. Other modules import only from this file.
export { createInviteRelationHitWriter } from './application/invite-relation-hits.ts';
export type {
  InviteRelationHitRuleId,
  InviteRelationHitInput,
  InviteRelationHitWriter,
  InviteRelationHitWriterOptions,
} from './application/invite-relation-hits.ts';
export { createSmsRisk, ephemeralSmsRiskIndex } from './application/sms-risk.ts';
export type {
  SmsRisk,
  SmsRiskOptions,
  SmsRiskRequest,
  SmsRiskAdmission,
} from './application/sms-risk.ts';
export {
  SameDeviceIsolationError,
  createSameDeviceAccountsCheck,
  sameDeviceAccountsCheckToken,
  sameDeviceLoginReaderToken,
} from './application/same-device-accounts.ts';
export type {
  SameDeviceFirstLogin,
  SameDeviceLoginReader,
  SameDeviceAccountsInput,
  SameDeviceAccountsResult,
  SameDeviceAccountsCheck,
  SameDeviceAccountsOptions,
} from './application/same-device-accounts.ts';
export {
  createDeviceRegistrationRisk,
  unkeyedDeviceRegistrationIndex,
} from './application/device-registration.ts';
export type {
  DeviceRegistrationRisk,
  DeviceRegistrationRiskOptions,
  DeviceRegistrationReservation,
  DeviceRegistrationAdmission,
} from './application/device-registration.ts';
export {
  createRateLimitService,
  createRateLimitThresholdReader,
} from './application/rate-limit.ts';
export type {
  RateLimitConfigReader,
  RateLimitThresholdReader,
  RateLimitRule,
  RateLimitRequest,
  RateLimitResult,
  RateLimitOptions,
  RateLimitService,
  RateLimitThresholdReaderOn,
} from './application/rate-limit.ts';
//
// Also compiled by the `test` project: this file and everything it exports use erasable syntax
// only, `import type` for type-only imports and relative imports with `.ts`; no parameter
// decorators or parameter properties (RiskModule carries a class decorator only, like
// PlatformModule). Loading this file loads @nestjs/common (through risk.module.ts and
// ../platform/index.ts). The ports are plain interfaces, so identity implements them without Nest
// types.
export { MINIMUM_VERSION_CHECK, RiskModule } from './risk.module.ts';
export { RiskScanModule } from './risk-scan.module.ts';
export {
  createRiskScan,
  riskScanToken,
  seedRiskScan,
  RISK_SCAN_QUEUE,
} from './application/risk-scan.ts';
export type { RiskScan, RiskScanOptions } from './application/risk-scan.ts';
export { RISK_SCAN_HEAL_INTERVAL_MS, startRiskScanHeal } from './application/risk-scan-heal.ts';
export type {
  RiskScanHealer,
  RiskScanHealControl,
  RiskScanHealSchedule,
} from './application/risk-scan-heal.ts';
export {
  RiskStateTransitionError,
  createRiskStateService,
  riskStateServiceToken,
} from './application/risk-state.ts';
export { canTransitionRiskState } from './domain/risk-state-transitions.ts';
export type {
  RiskReasonCategory,
  RiskSubject,
  RiskStateSnapshot,
  SetRiskState,
  RiskStateRequest,
  RiskStateService,
  RiskStateOptions,
} from './application/risk-state.ts';
export {
  createMinimumVersionCheck,
  createMinimumVersionGuard,
  contractMinimumVersionRoutes,
} from './application/minimum-version.ts';
export type {
  MinimumVersionReader,
  MinimumVersionReaderOn,
  MinimumVersionRequest,
  MinimumVersionCheck,
  MinimumVersionRoute,
  MinimumVersionGuard,
} from './application/minimum-version.ts';
export type {
  MinimumVersionReaders,
  RateLimitThresholdReaders,
  RiskModuleOptions,
} from './risk.module.ts';
export {
  DEVICE_SIGNING_KEYS,
  SIGNATURE_CHECK,
  SignatureError,
  createSignatureCheck,
  isSignatureCheck,
} from './application/signature-check.ts';
export type {
  DeviceSigningKey,
  DeviceSigningKeys,
  SignatureDependencies,
  SignatureRequest,
} from './application/signature-check.ts';
export { createBlocklistService, blocklistHmacContexts } from './application/blocklist.ts';
export type {
  BlocklistDimension,
  BlocklistInput,
  BlocklistHit,
  BlockedRequest,
  RecordBlockedHit,
  BlockedHitTarget,
  RegistrationBlock,
  BlockedRegistrationInput,
  RegistrationBlocklistInput,
  BlocklistOptions,
  BlocklistService,
} from './application/blocklist.ts';
