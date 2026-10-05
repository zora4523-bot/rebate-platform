// RFC 6238 TOTP verification primitive for admin accounts (BR-ID-34: admin login and
// dynamic-code step-up use TOTP). Login, first binding and step-up tokens are separate tasks;
// this file only answers "is this code valid now for this account, and not used before".
//
// Choices made here (F1-06b):
// - RFC 6238 with HMAC-SHA-1, T0 = 0, 30-second steps; the time is read from the injected Clock
//   at every call.
// - Window: the current step and one step either side, inclusive ([-1, +1]), i.e. a code is
//   usable for 60–90 seconds, which absorbs ordinary phone clock drift.
// - Code syntax: exactly `digits` ASCII decimal characters; leading zeroes are significant;
//   nothing is trimmed or normalised (full-width digits, signs, spaces are rejected).
// - Replay: a code is accepted only if the replay port atomically consumes
//   (app_id, admin_id, matched time step). The claim is the MATCHED step, not the server's
//   current step, so the same code cannot be used twice however the clock moves. A wrong or
//   malformed code never consumes a step. Failures of the port propagate (fail closed).
//
// Pure module (no decorators, erasable syntax, only type imports from the platform barrel).
import { createHmac, timingSafeEqual } from 'node:crypto';
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

export const TOTP_STEP_SECONDS = 30;
/** Steps accepted on each side of the current step. */
export const TOTP_WINDOW_STEPS = 1;

/** Field-encryption context of admin_users.totp_secret_cipher for one account. */
export function totpSecretContext(account: TotpAccount): string {
  return `admin_users.totp_secret:${account.appId}:${account.adminId}`;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 (upper case, optional `=` padding). Throws on any other character. */
export function decodeBase32(text: string): Buffer {
  const body = text.replace(/=+$/, '');
  if (body.length === 0) throw new Error('totp secret is empty');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of body) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('totp secret is not upper-case Base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP value for one counter, as a zero-padded decimal string. */
export function hotp(key: Uint8Array, counter: bigint, digits: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 time step of an instant (T0 = 0, 30 s). */
export function totpTimeStep(at: Date): bigint {
  return BigInt(Math.floor(at.getTime() / (TOTP_STEP_SECONDS * 1000)));
}

export function createTotpVerifier(deps: {
  clock: Clock;
  crypto: Pick<FieldCrypto, 'decrypt'>;
  replay: TotpReplayStore;
  digits: 6 | 8;
}): TotpVerifier {
  const { clock, crypto, replay, digits } = deps;
  const syntax = new RegExp(`^[0-9]{${String(digits)}}$`);
  return {
    async verify(request: TotpRequest): Promise<boolean> {
      const { code } = request;
      if (typeof code !== 'string' || code.length !== digits || !syntax.test(code)) return false;
      const account: TotpAccount = { appId: request.appId, adminId: request.adminId };
      const secret = crypto.decrypt(
        request.secretCipher.toString('utf8'),
        totpSecretContext(account),
      );
      const key = decodeBase32(secret);
      let matched: bigint | undefined;
      try {
        const current = totpTimeStep(clock.now());
        const given = Buffer.from(code, 'ascii');
        for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
          const step = current + BigInt(offset);
          if (step < 0n) continue;
          const expected = Buffer.from(hotp(key, step, digits), 'ascii');
          // Compare every candidate; keep the first match.
          if (timingSafeEqual(expected, given) && matched === undefined) matched = step;
        }
      } finally {
        key.fill(0);
      }
      if (matched === undefined) return false;
      return await replay.consume({ ...account, timeStep: matched });
    },
  };
}
