// BR-ID-33 细则「收款账号的脱敏格式」 for the withdrawal responses (task B2-05d): the same rules as
// platform/masking/payout-account.ts and identity's domain copy (maskAlipayLogonId /
// maskBankCardTail), which are not on the platform barrel (modules reach platform through its
// index.ts only; precedent identity/domain/mask-payout-account.ts). The cleartext is decrypted by
// identity's snapshot port and lives only long enough to be masked.
const MOBILE = /^1[0-9]{10}$/;

function maskPhone(phone: string): string {
  return MOBILE.test(phone)
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : '*'.repeat([...phone].length);
}

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

/** The masked snapshot account by payout method (BR-TEXT-06 masked_account). */
export function maskPayeeAccount(
  method: 'alipay' | 'bank_card' | 'wechat',
  account: string,
): string {
  if (method === 'alipay') return maskAlipayLogonId(account);
  if (method === 'bank_card') return maskBankCardTail(account);
  return '*'.repeat([...account].length);
}

/** payout_channel_name of the contract (BR-TEXT-06: never a fixed「支付宝」); one table, in display.ts. */
export { payoutChannelName } from './display.ts';
