// Registering or changing an admin account's verify phone (B1-34i; 08 BR-ID-45, BR-ID-33; contract
// CT-24o adminSendMyVerifyPhoneCode, adminChangeMyVerifyPhone, adminSendAdminVerifyPhoneCode,
// adminChangeAdminVerifyPhone). The send limit and the code validity are those of the sms step-up
// tier (./step-up-policy.ts; the contract points there); BR-ID-45 fixes neither.
//
// Pure module (no decorators, erasable syntax, no imports).

/**
 * Wrong codes a pending verify-phone code takes before it is voided (contract: "voided by too
 * many wrong tries"; the count is a technical default, as the login lock threshold). Wrong codes
 * here never count towards the login-failure lock (failed_login_count).
 */
export const VERIFY_PHONE_CODE_MAX_WRONG = 5;

/** Field-cipher context of the keyed hash of a pending verify-phone code of the account. */
export function verifyPhoneCodeContext(account: { appId: string; adminId: string }): string {
  return `admin_users.verify_phone_code:${account.appId}:${account.adminId}`;
}

// The normalised form of a verify phone (08 BR-ID-05 细则「手机号规范化」, the same steps as
// identity's normalize_phone; ./verify-phone-policy.test.ts pins it to
// specs/phone-normalize.vectors.json). A copy, not an import: identity's public surface carries
// Nest decorators and this module stays pure.
//
// Steps: ① Unicode NFKC; ② remove whitespace, U+200B–U+200D, U+FEFF and the hyphens '-' and
// U+2010–U+2015; ③ drop one country code: a leading '+86', or '0086' / '86' only when exactly 11
// digits follow; ④ the rest must match ^1[3-9][0-9]{9}$, otherwise null (mainland mobiles only).
const REMOVED = /[\s\u200B-\u200D\uFEFF\-\u2010-\u2015]/gu;
const MAINLAND_MOBILE = /^1[3-9][0-9]{9}$/;
const ZERO_ZERO_86 = /^0086[0-9]{11}$/;
const EIGHTY_SIX = /^86[0-9]{11}$/;

/** The 11-digit mainland mobile number of `input`, or null when it is not one. */
export function normalizeVerifyPhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  let text = input.normalize('NFKC').replace(REMOVED, '');
  if (text.startsWith('+86')) text = text.slice(3);
  else if (ZERO_ZERO_86.test(text)) text = text.slice(4);
  else if (EIGHTY_SIX.test(text)) text = text.slice(2);
  return MAINLAND_MOBILE.test(text) ? text : null;
}
