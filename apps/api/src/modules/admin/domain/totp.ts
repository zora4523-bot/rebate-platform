import type { Clock, FieldCrypto } from '../../platform/index.ts';

export interface TotpAccount {
  readonly appId: string;
  readonly adminId: string;
}

export interface TotpClaim extends TotpAccount {
  /** Matched counter, NOT the server's current counter. */
  readonly timeStep: bigint;
}

/**
 * Atomically consume (appId, adminId, timeStep); false means already consumed.
 * Production backing must be shared/durable across verifier instances and processes.
 * It must retain claims throughout their acceptance window; failures fail closed.
 * The backing storage is the implementer's choice; tests observe this port.
 */
export interface TotpReplayStore {
  consume(claim: TotpClaim): Promise<boolean>;
}

export interface TotpRequest extends TotpAccount {
  /** UTF-8 bytes of platform/crypto's envelope; decrypted value is uppercase Base32. */
  readonly secretCipher: Buffer;
  readonly code: string;
}

export interface TotpVerifier {
  /** false for invalid syntax, wrong/out-of-window code or replay; never consume bad codes. */
  verify(request: TotpRequest): Promise<boolean>;
}

/**
 * RFC 6238 SHA-1, T0=0, 30-second steps, inclusive [-1,+1] window.
 * Exactly digits ASCII decimal characters, preserving leading zeroes (no trimming).
 * Decrypt using context `admin_users.totp_secret:<appId>:<adminId>`.
 * Eight digits support Appendix B; super verification always uses six digits.
 * Clock is read for EACH verification. No runtime import of the Nest platform barrel.
 */
export function createTotpVerifier(deps: {
  clock: Clock;
  crypto: Pick<FieldCrypto, 'decrypt'>;
  replay: TotpReplayStore;
  digits: 6 | 8;
}): TotpVerifier {
  void deps;
  throw new Error('NotImplemented: createTotpVerifier');
}
