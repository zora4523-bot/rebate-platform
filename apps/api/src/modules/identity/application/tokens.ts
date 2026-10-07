// Nest tokens of the identity module's SMS code wiring (identity.module.ts).

/**
 * The identity configuration port (SmsConfigReader of ./sms-codes.ts): content's reader, built by
 * the factory app.module hands to IdentityModule.forRoot; null when the process has no database.
 */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

/** The SmsCodeService; null when the process has no Redis or no configuration reader. */
export const SMS_CODES = Symbol('SMS_CODES');

// Nest tokens of the session wiring (B1-02h, identity.module.ts).

/** The TokenKeyProvider (access-tokens.ts): configured key, or an ephemeral one in local / test. */
export const TOKEN_KEYS = Symbol('TOKEN_KEYS');

/** The TokenService that issues and verifies access tokens and issues refresh tokens. */
export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');

/** The stage ② ③ RequestCheck (createTokenCheck); app.module lists it right after the signature check. */
export const TOKEN_CHECK = Symbol('TOKEN_CHECK');

/** The Logout use case (logout.ts). */
export const LOGOUT = Symbol('LOGOUT');

// Nest token of the SMS login wiring (B1-02j, identity.module.ts).

/** The SmsLoginService; null when the process has no database, Redis or field cipher. */
export const SMS_LOGIN = Symbol('SMS_LOGIN');

// Nest token of the refresh wiring (B1-02k, identity.module.ts).

/** The RefreshService; null when the process has no database, Redis or field cipher. */
export const REFRESH = Symbol('REFRESH');
