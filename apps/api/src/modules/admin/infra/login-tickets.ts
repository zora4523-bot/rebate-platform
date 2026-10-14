// Login tickets of the admin console (F1-06k; 08 BR-ID-34 细则「首次绑定身份验证器」「首次登录强制改
// 密码」; ruling §9.2 #2, §9.3 #6), kept in Redis (namespace `admin-auth`).
//
// A ticket is an opaque random string (32 random bytes, base64url) handed to the client once. Redis
// keeps only its SHA-256 under the step it was issued for (`ticket:<step>:<sha256>`), so a ticket
// presented at another step simply is not found, and nothing in Redis can be replayed as a ticket.
// The stored record names the account and the expiry instant read from the injected Clock (the
// Redis TTL only cleans up); a bind ticket also carries the pending TOTP secret, encrypted with
// the field cipher for the account's context (BR-ID-33 field encryption).
//
// One-time use: `take` removes the record atomically (one Lua GET + DEL) before the caller checks
// anything, so of two concurrent requests with the same ticket exactly one gets it; a caller that
// must keep the ticket usable (wrong code, rejected password, lock) puts it back with `restore`,
// whose expiry is the original one (never extended). `peek` reads without consuming (the binding
// secret may be fetched again with the same ticket).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { createHash, randomBytes } from 'node:crypto';
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import type { AdminLoginStep } from '../domain/login-policy.ts';

export interface TicketRecord {
  readonly adminId: string;
  readonly appId: string;
  /** Epoch milliseconds from the injected Clock; at or after it the ticket is expired. */
  readonly expiresAtMs: number;
  /** Bind tickets only: field-cipher envelope of the pending Base32 secret. */
  readonly secretCipher?: string;
}

export interface TakenTicket {
  readonly step: AdminLoginStep;
  readonly hash: string;
  readonly record: TicketRecord;
}

export interface LoginTickets {
  /** Stores a new ticket and returns it (never stored in clear). */
  issue(step: AdminLoginStep, record: TicketRecord): Promise<string>;
  /** Atomically removes and returns the ticket's record for that step; undefined if none. */
  take(step: AdminLoginStep, ticket: string): Promise<TakenTicket | undefined>;
  /** Puts a taken ticket back with its original expiry (no-op once expired). */
  restore(taken: TakenTicket): Promise<void>;
  /** Reads without consuming. */
  peek(step: AdminLoginStep, ticket: string): Promise<TicketRecord | undefined>;
}

/** Extra Redis lifetime beyond the Clock expiry: cleanup only, never what decides expiry. */
const CLEANUP_MARGIN_SEC = 60;

const TAKE_SCRIPT = `local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;

const keyOf = (step: AdminLoginStep, hash: string): string => `ticket:${step}:${hash}`;
const hashOf = (ticket: string): string =>
  createHash('sha256').update(ticket, 'utf8').digest('hex');

function parse(value: unknown): TicketRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<TicketRecord>;
    if (
      typeof parsed.adminId !== 'string' ||
      typeof parsed.appId !== 'string' ||
      typeof parsed.expiresAtMs !== 'number' ||
      (parsed.secretCipher !== undefined && typeof parsed.secretCipher !== 'string')
    ) {
      return undefined;
    }
    return parsed as TicketRecord;
  } catch {
    return undefined;
  }
}

export function createLoginTickets(deps: {
  readonly redis: RedisNamespace;
  readonly clock: Clock;
}): LoginTickets {
  const { redis, clock } = deps;
  const ttlOf = (expiresAtMs: number): number =>
    Math.max(1, Math.ceil((expiresAtMs - clock.now().getTime()) / 1000)) + CLEANUP_MARGIN_SEC;

  return {
    async issue(step, record) {
      const ticket = randomBytes(32).toString('base64url');
      await redis.set(
        keyOf(step, hashOf(ticket)),
        JSON.stringify(record),
        ttlOf(record.expiresAtMs),
      );
      return ticket;
    },

    async take(step, ticket) {
      const hash = hashOf(ticket);
      const value = await redis.eval(TAKE_SCRIPT, {
        keys: [keyOf(step, hash)],
        args: [],
        ttlSeconds: 1,
      });
      const record = parse(value);
      return record === undefined ? undefined : { step, hash, record };
    },

    async restore(taken) {
      if (taken.record.expiresAtMs <= clock.now().getTime()) return;
      await redis.set(
        keyOf(taken.step, taken.hash),
        JSON.stringify(taken.record),
        ttlOf(taken.record.expiresAtMs),
      );
    },

    async peek(step, ticket) {
      return parse(await redis.get(keyOf(step, hashOf(ticket))));
    },
  };
}
