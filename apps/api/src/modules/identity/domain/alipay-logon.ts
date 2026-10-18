// 支付宝登录号的规范化 (规划/08 BR-WDR-02 细则; migration 0009 header; vectors:
// specs/payout-logon-normalize.vectors.json for the e-mail form, specs/phone-normalize.vectors.json
// for the phone form). The normalised value is what is encrypted, what alipay_hmac is computed on
// and what a payout transfers to; nothing hashes an unnormalised logon id.
//
// Steps: ① Unicode NFKC; ② remove every white space (JavaScript \s, which covers U+3000, U+00A0 and
// U+FEFF) and the zero-width characters U+200B–U+200D; ③ the form is decided by "@" after ①②:
//   - e-mail form (contains "@"): lower-case the whole value; exactly one "@" with a non-empty local
//     part and a non-empty domain, otherwise 20001 data.fields=[alipay_logon_id] (no reason);
//   - phone form (no "@"): normalize_phone, the same function as login (BR-ID-05); anything but an
//     11-digit mainland mobile number is 20001 data.fields=[alipay_logon_id], reason phone_invalid.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports.
import { normalize_phone } from './normalize-phone.ts';

/** The request field the refusals point at (contract SavePayoutAccountByAlipay). */
export const ALIPAY_LOGON_FIELD = 'alipay_logon_id';

export type NormalizedAlipayLogon =
  | { readonly code: 0; readonly logon: string }
  | {
      readonly code: 20001;
      readonly data: {
        readonly fields: readonly [typeof ALIPAY_LOGON_FIELD];
        readonly reason?: 'phone_invalid';
      };
    };

const INVISIBLE = /[\s\u200B-\u200D\uFEFF]/gu;

/** The normalised alipay logon id of `input`, or 20001 naming alipay_logon_id. */
export function normalizeAlipayLogonId(input: string): NormalizedAlipayLogon {
  const text = input.normalize('NFKC').replace(INVISIBLE, '');
  if (text.includes('@')) {
    const parts = text.split('@');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      return { code: 20001, data: { fields: [ALIPAY_LOGON_FIELD] } };
    }
    return { code: 0, logon: text.toLowerCase() };
  }
  const phone = normalize_phone(text);
  return phone.code === 0
    ? { code: 0, logon: phone.phone }
    : { code: 20001, data: { fields: [ALIPAY_LOGON_FIELD], reason: 'phone_invalid' } };
}
