// Card BIN and bank-card three-element verification adapters (规划/08 BR-WDR-02 ⑥ ⑦; task B1-13f §9.2
// #7, E8, E9; precedent fake-realname-verifier.ts).
//
// - createFakeCardBin: local and test only (any other APP_ENV throws). A tiny demonstration BIN
//   table with obviously fictional 99000x prefixes and「示例银行」-style names; it is no bank's data
//   and is never used outside local / test. Anything else (every real BIN) is unrecognised (null).
// - createFakeBankCardVerifier: local and test only. Every verification is a match; query answers
//   what this process verified under that vendor_request_id, else not_found. It imitates no
//   vendor's messages and keeps nothing of the name, ID number or card number.
// - createCardBin / createBankCardVerifier: what identity.module provides: the fakes in local /
//   test; in staging / prod null until the owner picks the BIN source and the three-element vendor
//   (the request then answers 50301 before any reservation). No vendor answer is ever faked
//   outside local / test.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { BankCardVerifierPort, CardBinPort } from '../ports/bank-card-verifier.ts';

/** Demonstration BINs only: fictional prefixes, fictional bank names. */
const DEMO_BINS: ReadonlyMap<
  string,
  { readonly card_type: 'debit' | 'credit'; readonly bank_name: string }
> = new Map([
  ['990001', { card_type: 'debit', bank_name: '示例银行' }],
  ['990002', { card_type: 'debit', bank_name: '示例商业银行' }],
  ['990009', { card_type: 'credit', bank_name: '示例银行' }],
]);
const BIN_LENGTH = 6;
/** The fake keeps at most this many vendor_request_id answers (oldest dropped first). */
const MAX_REMEMBERED = 10_000;

function isFakeEnvironment(appEnv: string): boolean {
  return appEnv === 'local' || appEnv === 'test';
}

function refuse(adapter: string): never {
  throw new Error(`identity: the fake ${adapter} runs only when APP_ENV is local or test`);
}

/** Only local / test may construct this adapter: the demonstration BIN table. */
export function createFakeCardBin(appEnv: string): CardBinPort {
  if (!isFakeEnvironment(appEnv)) refuse('card BIN table');
  return Object.freeze({
    lookup(digits: string) {
      const bin = digits.slice(0, BIN_LENGTH);
      const entry = DEMO_BINS.get(bin);
      return Promise.resolve(entry === undefined ? null : { ...entry, bin });
    },
  });
}

/** Only local / test may construct this adapter: every verification matches. */
export function createFakeBankCardVerifier(appEnv: string): BankCardVerifierPort {
  if (!isFakeEnvironment(appEnv)) refuse('bank card verifier');
  const answers = new Map<string, 'match' | 'mismatch'>();
  return Object.freeze({
    verify(input: Parameters<BankCardVerifierPort['verify']>[0]) {
      if (answers.size >= MAX_REMEMBERED) {
        const oldest = answers.keys().next();
        if (oldest.done !== true) answers.delete(oldest.value);
      }
      answers.set(input.vendor_request_id, 'match');
      return Promise.resolve('match' as const);
    },
    query(vendorRequestId: string) {
      return Promise.resolve(answers.get(vendorRequestId) ?? ('not_found' as const));
    },
  });
}

/** Application assembly seam, analogous to createRealnameVerifier; absent outside local/test. */
export function createBankCardVerifier(appEnv: string): BankCardVerifierPort | null {
  // TODO(规划/11 §7.1): 银行卡三要素核验供应商的真实适配器 — blocked on 负责人选型与开通（花钱 / 新供应商，E8）
  return isFakeEnvironment(appEnv) ? createFakeBankCardVerifier(appEnv) : null;
}

/** Demo BIN data only; application assembly uses this factory. */
export function createCardBin(appEnv: string): CardBinPort | null {
  // TODO(规划/11 §7.1): 真实卡 BIN 数据来源 — blocked on 负责人选定来源（E9）
  return isFakeEnvironment(appEnv) ? createFakeCardBin(appEnv) : null;
}
