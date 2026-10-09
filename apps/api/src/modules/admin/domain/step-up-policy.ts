// Admin step-up values (F1-06l; 08 BR-ID-34 「后台 step-up 分两档」; ruling §9.2 #3, #4). BR-ID-34
// leaves the SMS limits, the code validity and the token lifetime open; the contract responses
// state the values in force (adminSendStepUpSms: resend_after_sec / expires_in_sec; adminStepUp:
// expire_at).
//
// Pure module (no decorators, erasable syntax).

/** A step_up_token is valid for 5 minutes by the Clock and serves one successful operation. */
export const STEP_UP_TOKEN_TTL_MS = 5 * 60 * 1000;
/** An SMS step-up code is valid for 300 seconds by the Clock; only the latest one sent counts. */
export const STEP_UP_SMS_CODE_TTL_MS = 300 * 1000;
/** One SMS per account (across its sessions) every 60 seconds by the Clock. */
export const STEP_UP_SMS_RESEND_MS = 60 * 1000;
/** Six digits, as the authenticator code (AdminTotpCode). */
export const STEP_UP_SMS_CODE_DIGITS = 6;
/**
 * Every SMS code sent is remembered (as its keyed hash) for 24 hours by the Clock, apart from the
 * current code's 300 seconds, so a replaced, used or expired code answers 20003 rather than a
 * counted 20002 (ruling round 3 #1).
 */
export const STEP_UP_SMS_HISTORY_MS = 24 * 60 * 60 * 1000;
/** At most this many remembered hashes per account; the oldest go first. */
export const STEP_UP_SMS_HISTORY_KEEP = 32;
/** Extra Redis lifetime beyond the Clock-judged limits: cleanup only. */
export const STEP_UP_CLEANUP_MARGIN_SEC = 60;

/** Field-cipher context of admin_users.verify_phone_cipher (as totp_secret's). */
export function verifyPhoneContext(account: { appId: string; adminId: string }): string {
  return `admin_users.verify_phone:${account.appId}:${account.adminId}`;
}

/**
 * BR-ID-33 default display mask, as platform/masking's maskPhone (not on the platform barrel):
 * an 11-digit mainland mobile number shows its first 3 and last 4 digits (138****5678); anything
 * else is one "*" per code point.
 */
export function maskVerifyPhone(phone: string): string {
  return /^1[0-9]{10}$/.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : '*'.repeat([...phone].length);
}

/** Whole seconds to wait, rounded up, at least 1 (Retry-After). */
export function retryAfterSeconds(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}
