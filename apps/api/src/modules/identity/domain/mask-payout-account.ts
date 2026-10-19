// BR-ID-33 细则「收款账号的脱敏格式」 for GET /v1/me/payout-account and the save answer (task B1-13e):
// the same rules as platform/masking/payout-account.ts (maskAlipayLogonId / maskBankCardTail /
// maskPayeeName), which are not on the platform barrel (modules reach platform through its
// index.ts only; precedent mask-name.ts, mask-phone.ts). The callers pass the value normalised when
// the account was bound; anything not of an accepted form is one "*" per code point.
//
// Also compiled by the `test` project: erasable syntax only, `.ts` relative imports.
import { maskName } from './mask-name.ts';
import { maskPhone } from './mask-phone.ts';

/** 支付宝登录号: phone form 138****5678, e-mail form zh***@example.com (a***@x.com, ***@x.com). */
export function maskAlipayLogonId(logonId: string): string {
  const at = logonId.indexOf('@');
  if (at === -1) return maskPhone(logonId);
  if (
    at === 0 ||
    at === logonId.length - 1 ||
    at !== logonId.lastIndexOf('@') ||
    /[\s\p{C}]/u.test(logonId)
  ) {
    return '*'.repeat([...logonId].length);
  }
  const local = [...logonId.slice(0, at)];
  const kept = Math.min(2, local.length - 1);
  return `${local.slice(0, kept).join('')}***${logonId.slice(at)}`;
}

/** 银行卡: 「尾号 1234」 (the bank name is a separate field). */
export function maskBankCardTail(cardNo: string): string {
  return /^[0-9]{12,19}$/.test(cardNo)
    ? `尾号 ${cardNo.slice(-4)}`
    : '*'.repeat([...cardNo].length);
}

/** 收款人姓名: only the last character stays (**三). */
export function maskPayeeName(name: string): string {
  return maskName(name);
}
