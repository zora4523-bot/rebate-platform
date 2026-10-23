// The normalised form of a site alert phone (B1-22b; 08 BR-ID-05 细则「手机号规范化」, the same steps
// as identity's normalize_phone; ./phone.test.ts pins it to specs/phone-normalize.vectors.json).
// A copy, not an import: identity's public surface carries Nest decorators, and union is compiled
// by the erasable-syntax `test` project.
//
// Steps: ① Unicode NFKC; ② remove whitespace, U+200B–U+200D, U+FEFF and the hyphens '-' and
// U+2010–U+2015; ③ drop one country code: a leading '+86', or '0086' / '86' only when exactly 11
// digits follow; ④ the rest must match ^1[3-9][0-9]{9}$, otherwise null (mainland mobiles only).

const REMOVED = /[\s\u200B-\u200D\uFEFF\-\u2010-\u2015]/gu;
const MAINLAND_MOBILE = /^1[3-9][0-9]{9}$/;
const ZERO_ZERO_86 = /^0086[0-9]{11}$/;
const EIGHTY_SIX = /^86[0-9]{11}$/;

/** The 11-digit mainland mobile number of `input`, or null when it is not one. */
export function normalizeAlertPhone(input: string): string | null {
  if (typeof input !== 'string') return null;
  let text = input.normalize('NFKC').replace(REMOVED, '');
  if (text.startsWith('+86')) text = text.slice(3);
  else if (ZERO_ZERO_86.test(text)) text = text.slice(4);
  else if (EIGHTY_SIX.test(text)) text = text.slice(2);
  return MAINLAND_MOBILE.test(text) ? text : null;
}
