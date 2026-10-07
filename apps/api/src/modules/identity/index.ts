// Public surface of the identity module. Other modules import only from this file.
export { IdentityModule } from './identity.module.ts';
export type { IdentityConfigReader, IdentityModuleOptions } from './identity.module.ts';
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
