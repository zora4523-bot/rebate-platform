// Admission gate of POST /v1/agent/sessions/{id}/messages, steps ⑥–⑩ of BR-AI-23 (B3-03c).
// Quota numbers, counting keys, counting time, refunds and the 30502 data: BR-AI-15. Steps ①–⑤
// (open, identity, consent, session ownership, length) are judged before by the caller (B3-03d);
// the risk module's IP limit is elsewhere. The rule tests in test/spec/agent/stream-admission/**
// import this file by path: the names, signatures and semantics written here are the contract.
//
// Spec: BR-AI-23 table row and 细则 as of planning e9fe98a (2026-10-06: ⑥ with a running original
// ends with 30506, ⑥⑦ and ⑧–⑩ in one Lua, the run lock holds the run_id, 「受理记录与收尾」).
//
// admit(req, limits) — exactly one Redis eval per call (no other get / set / eval; the only extra
// eval is the compensation after an ambiguous failure, below) judges, in this order, and returns
// the first hit:
//   ⑥ (sessionId, clientMsgId) already accepted → duplicate{ticket of that acceptance, state};
//     nothing else is judged (also while a lock is held or the day quota is used up), nothing is
//     counted or written. state: 'running' when the session lock holds that ticket's runId and is
//     not expired (the caller answers meta duplicate=true + error 30506); else 'settled' when that
//     ticket was settled (the caller replays agent_runs.final_event); else 'unsettled' (crash: the
//     caller completes the tail — settle — then replays). The acceptance record is kept (TTL ≥ 48 h)
//     until PG takes over; judging it by clock never drops it within 48 h of acceptance.
//   ⑦ the session lock holds a runId and now < its lockExpiresAtMs → 30506. When the lock has
//     expired (or is gone) but the session's last accepted ticket was never settled →
//     unsettled{that ticket}: the caller settles it first (BR-AI-23 「谁来收尾」) and admits again.
//   ⑧ per-minute limit (member: userId; guest tier: deviceHash only, whatever ipKey or loggedIn) →
//     42901. Sliding 60 s window over accepted messages: one accepted at t counts while
//     now − t < 60 000 ms; retryAfterSeconds = ceil((oldest counted t + 60 000 − now) / 1000), ≥ 1.
//   ⑨ rounds accepted in this session (ever, not per day) ≥ maxRounds → 30504 reason round_limit.
//   ⑩ day quota (member: userId vs memberDaily; guest tier: deviceHash vs guestDaily and ipKey vs
//     guestIpDaily, either full rejects) → 30502 {resetAt: nextResetAt(now), next: nextStepOf}.
//   Only a request passing ⑩ writes anything, all in that same eval: the acceptance record
//   (clientMsgId → ticket: runId, messageId, subject, dayKey; 08 BR-AI-23 「受理记录」), the session lock (value = runId, lockExpiresAtMs = acceptedAtMs +
//   runMaxMs + lockGraceMs) and the session's last ticket, one minute-window entry, one round and
//   one day count on every counting key. A rejected request changes no stored value.
//   quotaLeft = what is left today after this message (guest: the smaller of device and IP).
// settle(ticket, outcome, limits) — at run end (done, error, cancel) or by the caller completing a
// crashed run's tail (outcome as registered; unknown card delivery counts as 0 cards; no reason at
// all → server_error, i.e. 50001). Removes the session lock only when it holds ticket.runId (a later
// run's lock stays). When shouldRefund(outcome), gives back 1 on every day counter of the ticket's
// acceptance day (ticket.dayKey), never below 0; minute window and rounds are not given back.
// Settled once per ticket, atomically in one eval (the settled mark, the refund and the lock
// removal together; two instances settling the same ticket at once refund at most 1): a later
// settle (any outcome) changes no count and returns the first settlement's `refunded`. quotaLeft:
// what is left today — the day of the settle time (+08:00), not the acceptance day — after the
// refund, counted on the ticket's subject (guest: the smaller of device and IP); the value of
// done.quota_left (BR-AI-15 「本条结束后当日剩余条数」).
// Out of scope here: registering the termination reason and card delivery while the run is going,
// agent_runs.final_event and the PG takeover of the acceptance record (B3-03b / B3-03d, 12 X-10).
// Guest tier = guest and logged in without phone (BR-ID-03): the same deviceHash shares one count
// whatever `loggedIn`; a member counts by userId only (guest counts never move to it).
//
// Time: epoch ms of the injected Clock, passed into the script; windows, lock expiry and the day
// (Asia/Shanghai, +08:00, by acceptance time) are judged on it, never on Redis TTLs or Redis time.
// Every key a script writes gets a positive TTL (garbage collection only), never shorter than
// runMaxMs + lockGraceMs: a key holding the lock or the last ticket outlives the lock. Keys are built from the
// caller's opaque values (userId, deviceHash, ipKey, sessionId, clientMsgId) only.
// Redis unavailable (RedisUnavailableError or any failed call): admit rejects with
// AdmissionUnavailableError and counts nothing; the caller answers 50401. When it is unknown
// whether the admit eval ran (command_timeout, unexpected_reply, a reply that is not the script's
// JSON), admit first makes one compensating settle eval for req.runId as server_error with 0 cards
// (BR-AI-15 refund), applied only if this very request was recorded (msg:<clientMsgId> → runId);
// otherwise it changes nothing. The settled mark keeps it once-only against a later settle.
//
// shouldRefund: endings server_error, disabled, timeout, input_review_timeout with
// cardsDelivered = 0 → true; anything else → false (BR-AI-15 refund list).
// dayKeyOf(now): 'YYYY-MM-DD' of `now` at +08:00. nextResetAt(now): next 00:00 at +08:00 written
// 'YYYY-MM-DDT00:00:00+08:00'. nextStepOf: member none, logged-in guest tier bind_phone, guest
// login. admissionDefaults(): the BR-AI-15 defaults, for the caller when config_items has none.
//
// Rules for the implementation: also compiled by the `test` project: erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no NestJS import, no
// process.env, time only from the injected Clock.
import type { Clock, RedisNamespace } from '../../../platform/index.ts';
import { RedisUnavailableError } from '../../../platform/redis/index.ts';
import { ADMIT_SCRIPT, SETTLE_SCRIPT } from './scripts.ts';

export type QuotaSubject =
  | { readonly tier: 'member'; readonly userId: string }
  | {
      readonly tier: 'guest';
      readonly loggedIn: boolean;
      readonly deviceHash: string;
      readonly ipKey: string;
    };

export interface AdmissionLimits {
  readonly memberDaily: number;
  readonly guestDaily: number;
  readonly guestIpDaily: number;
  readonly perMinute: number;
  readonly maxRounds: number;
}

export interface AdmissionRequest {
  readonly sessionId: string;
  readonly clientMsgId: string;
  readonly runId: string;
  /** The user message id (agent_messages), generated by the caller like runId. */
  readonly messageId: string;
  readonly subject: QuotaSubject;
}

export interface AdmissionTicket {
  readonly runId: string;
  /** The user message id (agent_messages), generated by the caller like runId. */
  readonly messageId: string;
  readonly sessionId: string;
  readonly subject: QuotaSubject;
  readonly dayKey: string;
  readonly acceptedAtMs: number;
  readonly lockExpiresAtMs: number;
}

export type NextStep = 'login' | 'bind_phone' | 'none';

export type DuplicateState = 'running' | 'settled' | 'unsettled';

export type AdmissionResult =
  | { readonly kind: 'accepted'; readonly ticket: AdmissionTicket; readonly quotaLeft: number }
  | { readonly kind: 'duplicate'; readonly ticket: AdmissionTicket; readonly state: DuplicateState }
  | { readonly kind: 'unsettled'; readonly ticket: AdmissionTicket }
  | { readonly kind: 'rejected'; readonly code: 30506 }
  | { readonly kind: 'rejected'; readonly code: 42901; readonly retryAfterSeconds: number }
  | { readonly kind: 'rejected'; readonly code: 30504; readonly reason: 'round_limit' }
  | {
      readonly kind: 'rejected';
      readonly code: 30502;
      readonly resetAt: string;
      readonly next: NextStep;
    };

export type RunEnding =
  | 'stop'
  | 'fallback'
  | 'budget'
  | 'auth_required'
  | 'safety'
  | 'limit'
  | 'client_error'
  | 'cancelled'
  | 'disconnected'
  | 'consent_withdrawn'
  | 'timeout'
  | 'disabled'
  | 'input_review_timeout'
  | 'server_error';

export interface RunOutcome {
  readonly ending: RunEnding;
  readonly cardsDelivered: number;
}

export interface SettleResult {
  readonly refunded: boolean;
  readonly quotaLeft: number;
}

export interface Admission {
  admit(req: AdmissionRequest, limits: AdmissionLimits): Promise<AdmissionResult>;
  settle(
    ticket: AdmissionTicket,
    outcome: RunOutcome,
    limits: AdmissionLimits,
  ): Promise<SettleResult>;
}

export interface AdmissionDeps {
  readonly redis: RedisNamespace;
  readonly clock: Clock;
  readonly runMaxMs: number;
  readonly lockGraceMs: number;
}

export class AdmissionUnavailableError extends Error {}

export function admissionDefaults(): AdmissionLimits {
  return { memberDaily: 30, guestDaily: 3, guestIpDaily: 30, perMinute: 10, maxRounds: 30 };
}

export function shouldRefund(outcome: RunOutcome): boolean {
  return (
    outcome.cardsDelivered === 0 &&
    ['server_error', 'disabled', 'timeout', 'input_review_timeout'].includes(outcome.ending)
  );
}

const DAY_MS = 86_400_000;
// Quota days are civil dates, not ledger accounting dates. Format only the supplied instant.
const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: '+08:00',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDay(ms: number): string {
  const parts = DAY_FORMAT.formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function dayKeyOf(now: Date): string {
  return formatDay(now.getTime());
}

export function nextResetAt(now: Date): string {
  return `${formatDay(now.getTime() + DAY_MS)}T00:00:00+08:00`;
}

export function nextStepOf(subject: QuotaSubject): NextStep {
  return subject.tier === 'member' ? 'none' : subject.loggedIn ? 'bind_phone' : 'login';
}

// JSON tuples preserve opaque identifiers (including separators) without key collisions.
function key(...parts: string[]): string {
  return JSON.stringify(parts);
}

function subjectKeys(subject: QuotaSubject): string[] {
  return subject.tier === 'member'
    ? [key('member', subject.userId)]
    : [key('device', subject.deviceHash), key('ip', subject.ipKey)];
}

function dailyKeys(subject: QuotaSubject, day: string): string[] {
  return subjectKeys(subject).map((subjectKey) => key('day', subjectKey, day));
}

function dailyLimits(subject: QuotaSubject, limits: AdmissionLimits): number[] {
  return subject.tier === 'member'
    ? [limits.memberDaily]
    : [limits.guestDaily, limits.guestIpDaily];
}

function nonNegativeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Admission settings must be non-negative safe integers');
  }
}

function validateLimits(limits: AdmissionLimits): void {
  for (const value of [
    limits.memberDaily,
    limits.guestDaily,
    limits.guestIpDaily,
    limits.perMinute,
    limits.maxRounds,
  ])
    nonNegativeInteger(value);
}

export function createRedisAdmission(deps: AdmissionDeps): Admission {
  nonNegativeInteger(deps.runMaxMs);
  nonNegativeInteger(deps.lockGraceMs);
  const lockMs = deps.runMaxMs + deps.lockGraceMs;
  nonNegativeInteger(lockMs);
  // Retain acceptance and settlement together, at least 48 h and beyond the logical lock.
  // Session ownership/expiry and PG takeover are the caller's responsibility (B3-03d).
  const ttlSeconds = Math.max(48 * 60 * 60, Math.ceil(lockMs / 1000) + 1);

  // The eval reached Redis but its reply is unusable: the script may or may not have run.
  class AmbiguousReply extends Error {}

  async function evaluate<T>(script: string, keys: string[], payload: unknown): Promise<T> {
    const result = await deps.redis.eval(script, {
      keys,
      args: [JSON.stringify(payload)],
      ttlSeconds,
    });
    if (typeof result !== 'string') throw new AmbiguousReply();
    try {
      return JSON.parse(result) as T;
    } catch {
      throw new AmbiguousReply();
    }
  }

  // Unknown whether the script ran. connect_* and closed never sent it; command_failed is an error
  // reply, and both scripts raise errors only before their first write.
  function ambiguous(error: unknown): boolean {
    return (
      error instanceof AmbiguousReply ||
      (error instanceof RedisUnavailableError &&
        (error.reason === 'command_timeout' || error.reason === 'unexpected_reply'))
    );
  }

  function settleEval<T>(
    ticket: AdmissionTicket,
    refund: boolean,
    limits: AdmissionLimits,
    clientMsgId?: string,
  ): Promise<T> {
    const today = dayKeyOf(deps.clock.now());
    return evaluate<T>(
      SETTLE_SCRIPT,
      [
        key('session', ticket.sessionId),
        key('lock', ticket.sessionId),
        ...dailyKeys(ticket.subject, ticket.dayKey),
        ...dailyKeys(ticket.subject, today),
      ],
      { ticket, refund, dailyLimits: dailyLimits(ticket.subject, limits), clientMsgId },
    );
  }

  return {
    async admit(req, limits) {
      validateLimits(limits);
      const now = deps.clock.now();
      const ticket: AdmissionTicket = {
        runId: req.runId,
        messageId: req.messageId,
        sessionId: req.sessionId,
        subject: req.subject,
        dayKey: dayKeyOf(now),
        acceptedAtMs: now.getTime(),
        lockExpiresAtMs: now.getTime() + lockMs,
      };
      try {
        return await evaluate<AdmissionResult>(
          ADMIT_SCRIPT,
          [
            key('session', req.sessionId),
            key('lock', req.sessionId),
            key('minute', subjectKeys(req.subject)[0]!),
            ...dailyKeys(req.subject, ticket.dayKey),
          ],
          {
            ticket,
            clientMsgId: req.clientMsgId,
            windowMember: key(req.sessionId, req.clientMsgId),
            limits,
            dailyLimits: dailyLimits(req.subject, limits),
            resetAt: nextResetAt(now),
            next: nextStepOf(req.subject),
          },
        );
      } catch (error) {
        if (ambiguous(error)) {
          // The caller gets no ticket and never starts this run: if the admit did run, settle it
          // now as server_error with 0 cards so the day count is given back (BR-AI-15) and the
          // lock is released. One attempt; when it fails too, the record stays unsettled and is
          // finished by a retry of the same client_msg_id or the next message of the session
          // (⑥ / ⑦ unsettled, BR-AI-23 「谁来收尾」), or else by the sweeper B3-03e (runs with
          // no terminal state whose lock has expired).
          const failed: RunOutcome = { ending: 'server_error', cardsDelivered: 0 };
          await settleEval(ticket, shouldRefund(failed), limits, req.clientMsgId).catch(
            () => undefined,
          );
        }
        // Never expose Redis errors (which may contain identifiers) to the caller.
        throw new AdmissionUnavailableError('Admission storage unavailable');
      }
    },
    async settle(ticket, outcome, limits) {
      validateLimits(limits);
      try {
        return await settleEval<SettleResult>(ticket, shouldRefund(outcome), limits);
      } catch {
        throw new AdmissionUnavailableError('Admission storage unavailable');
      }
    },
  };
}
