// Public surface of the identity module. Other modules import only from this file.
export { IdentityModule } from './identity.module.ts';
export type { IdentityModuleOptions } from './identity.module.ts';
// BR-ID-05 细则「手机号规范化」: every module normalises a phone number with this function first.
export { normalize_phone } from './domain/normalize-phone.ts';
export type { NormalizedPhone } from './domain/normalize-phone.ts';
export type { SmsConfigReader } from './application/sms-codes.ts';
