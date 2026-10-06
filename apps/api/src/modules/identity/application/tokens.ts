// Nest tokens of the identity module's SMS code wiring (identity.module.ts).

/**
 * The identity configuration port (SmsConfigReader of ./sms-codes.ts): content's reader, built by
 * the factory app.module hands to IdentityModule.forRoot; null when the process has no database.
 */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

/** The SmsCodeService; null when the process has no Redis or no configuration reader. */
export const SMS_CODES = Symbol('SMS_CODES');
