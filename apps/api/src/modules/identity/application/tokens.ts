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

// Nest tokens of the second-verification wiring (B1-02f, identity.module.ts).

/** The OauthAttemptService (oauth-attempts.ts); null when the process has no database or Redis. */
export const OAUTH_ATTEMPTS = Symbol('OAUTH_ATTEMPTS');
export const OAUTH_LOGIN = Symbol('OAUTH_LOGIN');

/**
 * The ThirdPartyIdentityPort (step-up.ts) app.module may hand to IdentityModule.forRoot; null
 * when none is given: the third-party step-up then answers 50305 (CT-15i provides the exchange).
 */
export const THIRD_PARTY_IDENTITY = Symbol('THIRD_PARTY_IDENTITY');

/** The StepUpService; null when the process has no database, Redis, field cipher or SMS codes. */
export const STEP_UP = Symbol('STEP_UP');

/** The H5TokenService (h5-token.ts); null when the process has no configuration reader. */
export const H5_TOKENS = Symbol('H5_TOKENS');

/** The ConsentService (consents.ts); null when the process has no database. */
export const CONSENTS = Symbol('CONSENTS');

// Nest token of the one-time tips wiring (B1-02s, identity.module.ts).

/** The TipsService (tips.ts); null when the process has no database. */
export const TIPS = Symbol('TIPS');

/** First phone binding; null without its storage and read ports. */
export const BIND_PHONE = Symbol('BIND_PHONE');
/** The current-user read service, or null without the database and assembled ports. */
export const ME = Symbol('IDENTITY_ME');
/** Cross-module read ports of GET /v1/me, assembled by app.module. */
export const ME_READ_PORTS = Symbol('IDENTITY_ME_READ_PORTS');
/** Nickname content review, selected by environment. */
export const NICKNAME_REVIEW = Symbol('IDENTITY_NICKNAME_REVIEW');
/** The nickname update service, or null without the database. */
export const UPDATE_NICKNAME = Symbol('IDENTITY_UPDATE_NICKNAME');
