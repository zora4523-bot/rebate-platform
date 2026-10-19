import type { BankCardVerifierPort, CardBinPort } from '../ports/bank-card-verifier.ts';

/** Application assembly seam, analogous to createRealnameVerifier; absent outside local/test. */
export function createBankCardVerifier(appEnv: string): BankCardVerifierPort | null {
  void appEnv;
  throw new Error('NotImplemented: createBankCardVerifier');
}

/** Demo BIN data only; application assembly uses this factory. */
export function createCardBin(appEnv: string): CardBinPort | null {
  void appEnv;
  throw new Error('NotImplemented: createCardBin');
}

export function createFakeBankCardVerifier(appEnv: string): BankCardVerifierPort {
  void appEnv;
  throw new Error('NotImplemented: createFakeBankCardVerifier');
}

export function createFakeCardBin(appEnv: string): CardBinPort {
  void appEnv;
  throw new Error('NotImplemented: createFakeCardBin');
}
