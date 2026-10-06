// normalize_phone (规划/08 BR-ID-05 细则「手机号规范化」; vectors: specs/phone-normalize.vectors.json,
// shared with the three apps and the H5 landing pages). Every use of a phone number — the code and
// quota keys of the SMS codes, the prefix blocklist, users.phone_hmac, the blocklist, the alipay
// login phone form — goes through this function first; nothing hashes an unnormalised value.
// The server always normalises again: a client's cleaned value is never trusted.
//
// Steps: ① Unicode NFKC (full-width digits and plus sign become ASCII); ② remove every whitespace
// character (JavaScript \s, which covers U+3000, U+00A0 and U+FEFF), the zero-width characters
// U+200B–U+200D and U+FEFF, and the hyphens '-' and U+2010–U+2015 (not U+2212 minus); ③ drop one
// country code: a leading '+86', or '0086' / '86' only when exactly 11 digits follow; ④ the rest
// must match ^1[3-9][0-9]{9}$, otherwise 20001 with data.fields=[phone], data.reason=phone_invalid.
// MVP accepts mainland China mobile numbers only (Q-24 default A): any other country code is 20001.
//
// Also compiled by the `test` project: erasable syntax only, no imports.

export type NormalizedPhone =
  | { readonly code: 0; readonly phone: string }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    };

const REMOVED = /[\s\u200B-\u200D\uFEFF\-\u2010-\u2015]/gu;
const MAINLAND_MOBILE = /^1[3-9][0-9]{9}$/;
const ZERO_ZERO_86 = /^0086[0-9]{11}$/;
const EIGHTY_SIX = /^86[0-9]{11}$/;

const INVALID: NormalizedPhone = Object.freeze({
  code: 20001,
  data: Object.freeze({ fields: Object.freeze(['phone'] as const), reason: 'phone_invalid' }),
});

/** The 11-digit mainland mobile number of `input`, or 20001 phone_invalid. */
export function normalize_phone(input: string): NormalizedPhone {
  if (typeof input !== 'string') return INVALID;
  let text = input.normalize('NFKC').replace(REMOVED, '');
  if (text.startsWith('+86')) text = text.slice(3);
  else if (ZERO_ZERO_86.test(text)) text = text.slice(4);
  else if (EIGHTY_SIX.test(text)) text = text.slice(2);
  return MAINLAND_MOBILE.test(text) ? { code: 0, phone: text } : INVALID;
}
