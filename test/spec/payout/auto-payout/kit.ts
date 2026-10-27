// B2-11c rule tests (规划/08 BR-WDR-30 判定时点与并发 / 自动路径 / EXECUTE 未通过 / 告警, BR-WDR-26
// review_deadline, BR-WDR-05 守卫, BR-WDR-24 告警): the withdrawal.created consumer on a real
// PostgreSQL. Withdrawals come from the real W1 (B2-05d) with a fixed Clock; the real ledger, the
// real B2-05e commands, the real event bus (event_log) and B2-11a's facts reader run underneath.
// Only ports owned by other modules are in-memory: risk's state and appeal readers, identity's
// adult reader, the live blacklist check, commission's shares (none) — and B2-06c's executeBatch,
// which is a recording fake unless a test hands in the real one. Rows outside this task (earlier
// automatic withdrawals, holds, snapshots of risk flags) are seeded by INSERT / UPDATE, never by a
// fake production command. Members are funded on 2026-10-01 with an ADMIN_ADJUST so that nothing
// is credited "today" (⑥) unless a test posts it.
// Only *.int.test.ts files import this kit (they create the database).
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/events/types.ts';
import type { RiskStateBatchValue } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createAutoPayoutConsumer,
  type AutoPayoutConsumer,
  type AutoPayoutOptions,
} from '../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import {
  createPayoutExecute,
  type ExecuteBatchInput,
  type ExecuteBatchResult,
} from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import { createWithdrawalCommands } from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import { createWithdrawRiskFactsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-risk-facts.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { fixture, success, type Fixture, type Harness } from '../apply/kit.ts';

export { open, close, TIMEOUT } from '../apply/kit.ts';
export type { Harness, Fixture } from '../apply/kit.ts';

/** 2026-10-19 (Monday) 10:00 +08:00, the W1 instant of every withdrawal (apply kit's NOW). */
export const NOW = new Date('2026-10-19T02:00:00.000Z');
/** 2026-10-19 00:00 +08:00. */
export const DAY_START = new Date('2026-10-18T16:00:00.000Z');
/** 2026-10-01 00:00 +08:00. */
export const MONTH_START = new Date('2026-09-30T16:00:00.000Z');
/** The members' funding instant: not in NOW's +08:00 day. */
const FUNDED_AT = new Date('2026-10-01T02:00:00.000Z');
export const MINUTE = 60_000;
export const CONSUMER = 'payout-auto-payout';
export const QUEUE = 'evt.payout-auto-payout';
export const SYSTEM = 'system:auto_payout';
/** The BR-WDR-24 alert line of today's automatic total reaching 80% of platform_daily_max_fen. */
export const NEAR_CAP_ALERT = 'auto_payout_daily_near_cap';
/** ⑧ actual values without any order, withdrawal-received ratio or received commission. */
export const NO_WARN = {
  high_commission_order_ratio_bp: null,
  invalid_ratio_bp: null,
  withdraw_received_ratio_bp: null,
} as const;

/** withdraw.auto_payout.<name>. */
export function key(name: string): string {
  return `withdraw.auto_payout.${name}`;
}

/** The auto_decision written for a decision at `decidedAt` (rule_version: any number). */
export function decision(
  result: 'auto' | 'manual',
  failed: readonly string[],
  extra: Record<string, unknown> = {},
  decidedAt: Date = NOW,
) {
  return {
    result,
    failed_conditions: [...failed],
    warn_values: NO_WARN,
    rule_version: expect.any(Number),
    decided_at: decidedAt.toISOString(),
    ...extra,
  };
}

/** On `trx`: users row lock → lockBalances → one posting of `ledgerType` (signed: + credits). */
async function postOn(
  trx: Transaction<DB>,
  member: Fixture,
  amount: bigint,
  at: Date,
  ledgerType: string,
) {
  const ledger = createLedger({ clock: new FixedClock(at) });
  const selection = { appId: member.actor.appId, userIds: [member.actor.userId] };
  await lockUsersForUpdate(trx, selection);
  const [balance] = await ledger.lockBalances(trx, selection);
  const v = voucher(member.actor.appId, balance!.account_id, -amount);
  await ledger.post(trx, {
    ...v,
    entries: v.entries.map((e) => ({ ...e, ledger_type: ledgerType })),
  });
}

/** A member of `appId` with its own current payout account, funded on 2026-10-01. */
async function newMember(
  h: Harness,
  appId: string,
  method: 'alipay' | 'bank_card',
  balance: bigint,
): Promise<Fixture> {
  const member = await fixture(h, { appId, balance: 0n, method });
  if (balance !== 0n) {
    await h.db
      .transaction()
      .execute((trx) => postOn(trx, member, balance, FUNDED_AT, 'ADMIN_ADJUST'));
  }
  return member;
}

export interface SeedReviewed {
  userId: string;
  payeeHmac?: string;
  amount?: bigint;
  status?: WithdrawalState;
  reviewMode?: 'auto' | 'manual';
  reviewedAt?: Date;
  createdAt?: Date;
  appId?: string;
}

export async function setup(
  h: Harness,
  input: { method?: 'alipay' | 'bank_card'; balance?: bigint } = {},
) {
  const appId = `auto_${randomUUID()}`;
  const balance = input.balance ?? 100_000n;
  const f = await newMember(h, appId, input.method ?? 'alipay', balance);
  await f.set(key('enabled'), true);
  // W1's amount step (BR-WDR-04, default 100 fen) would refuse the ② boundary ¥300.01.
  await f.set('withdraw.amount_step_fen', 1);

  const risk = new Map<string, RiskStateBatchValue>();
  const appeals = new Map<string, 'frozen' | 'banned'>();
  const minors = new Set<string>();
  const blacklisted = new Set<string>();
  const logger = { warn: vi.fn() };
  const lockUsers = vi.fn(lockUsersForUpdate);
  /** What the fake executeBatch answers (default: the one member goes PAYING). */
  let answer = (batch: ExecuteBatchInput): ExecuteBatchResult => ({
    kind: 'executed',
    batchId: randomUUID(),
    paying: [...batch.members],
    left: [],
  });
  const execute = vi.fn(
    async (_trx: Transaction<DB>, batch: ExecuteBatchInput): Promise<ExecuteBatchResult> =>
      answer(batch),
  );
  const ports = {
    config: f.options.rules.config,
    risk: {
      async read(_executor: Kysely<DB>, request: { appId: string; userIds: readonly string[] }) {
        return new Map(
          request.userIds.map((id): [string, RiskStateBatchValue] => [
            id,
            risk.get(id) ?? { state: 'normal', frozen_until: null },
          ]),
        );
      },
    },
    appeal: {
      async read(_handle: Kysely<DB>, subject: { appId: string; userId: string }) {
        return appeals.get(subject.userId) ?? null;
      },
    },
  };
  const options: AutoPayoutOptions = {
    db: h.db,
    logger,
    clock: f.clock,
    ledger: f.ledger,
    lockUsersForUpdate: lockUsers,
    attempts: { hasAttempt: async () => false },
    eventBus: f.options.eventBus!,
    ...ports,
    facts: createWithdrawRiskFactsReader({
      shares: { orderIds: async () => [], estimate: async () => 0n },
    }),
    adult: { isAdult: async (_handle, subject) => !minors.has(subject.userId) },
    blacklist: { hit: async (_handle, subject) => blacklisted.has(subject.userId) },
    execute: { executeBatch: execute },
  };

  /** The factory, called inside each test (red is the skeleton's NotImplemented, never setup). */
  function consumer(overrides: Partial<AutoPayoutOptions> = {}): AutoPayoutConsumer {
    return createAutoPayoutConsumer({ ...options, ...overrides });
  }

  /** B2-06c's real EXECUTE on the same ports (payout jobs recorded by `send`, never run). */
  function realExecute() {
    const send = vi.fn(
      async (...args: [queue: string, name: string, payload: unknown, options: unknown]) => {
        void args;
        return 'synthetic-job';
      },
    );
    const service = createPayoutExecute({
      ...ports,
      ledger: f.ledger,
      queue: { send },
      eventBus: f.options.eventBus!,
      logger: { warn: vi.fn() },
    });
    return { service, send };
  }

  /** Another member of the same app (own payout account and payee HMAC). */
  function member(amount: bigint = balance) {
    return newMember(h, appId, 'alipay', amount);
  }

  /**
   * W1 of `who` for `amount` on `handle` (a transaction or the pool), then the B2-11a snapshot an
   * empty risk_flags as production W1 writes it (seed: risk flags are B2-11a's).
   */
  async function start(amount: bigint, who: Fixture = f, trx?: Transaction<DB>) {
    const run = async (t: Transaction<DB>) => {
      const id = success(await who.apply(t, amount)).withdrawal_id;
      await sql`UPDATE app.withdrawals SET risk_flags = '[]'::jsonb, risk_flags_at = created_at
        WHERE id = ${id}`.execute(t);
      return id;
    };
    return trx === undefined ? h.db.transaction().execute(run) : run(trx);
  }

  /** Seed only: the W1 snapshot of risk flags (B2-11a writes it in production). */
  async function seedRiskFlags(
    id: string,
    flags: readonly { code: string; value: unknown; threshold: unknown }[],
  ) {
    await sql`UPDATE app.withdrawals SET risk_flags = CAST(${JSON.stringify(flags)} AS jsonb)
      WHERE id = ${id}`.execute(h.db);
  }

  /** The withdrawal.created event W1 published for `id` (payload as withdraw-apply.ts). */
  async function event(
    id: string,
    eventId: string = randomUUID(),
    handle: Kysely<DB> = h.db,
  ): Promise<ReceivedEvent> {
    const current = await row(id, handle);
    return {
      eventId,
      appId,
      name: 'withdrawal.created',
      version: 1,
      occurredAt: current.created_at.toISOString(),
      consumer: CONSUMER,
      attempt: 1,
      payload: {
        withdrawal_id: id,
        user_id: current.user_id,
        amount_fen: Number(current.amount_fen),
        review_mode: current.review_mode,
      },
    };
  }

  async function row(id: string, handle: Kysely<DB> = h.db) {
    return handle
      .withSchema('app')
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  /**
   * Seed only: a withdrawal already reviewed (default: automatic, PAID_API, reviewed at NOW, of
   * `userId` with a fresh payee HMAC). No freeze is posted: these rows only feed ⑦ and ⑨.
   */
  async function seedReviewed(values: SeedReviewed) {
    const id = randomUUID();
    const status = values.status ?? 'PAID_API';
    const mode = values.reviewMode ?? 'auto';
    const reviewedAt = values.reviewedAt ?? NOW;
    const createdAt = values.createdAt ?? reviewedAt;
    const amount = values.amount ?? 100n;
    const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no, payout_channel,
       review_mode, reviewer_id, reviewed_at, reject_reason_code, paid_at, manual_entry_by,
       manual_confirm_by, created_at, updated_at)
      VALUES (${id}, ${values.appId ?? appId}, ${values.userId}, ${amount}, ${0n}, ${0n}, ${amount},
       'SERVICE_FEE', 'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
       ${values.payeeHmac ?? randomBytes(32).toString('hex')}, ${null}, ${status},
       ${randomBytes(16).toString('hex')}, 'alipay', ${mode},
       ${mode === 'manual' ? randomUUID() : null}, ${reviewedAt},
       ${status === 'REJECTED' ? 'OTHER' : null}, ${paid ? reviewedAt : null},
       ${status === 'PAID_MANUAL' ? randomUUID() : null},
       ${status === 'PAID_MANUAL' ? randomUUID() : null}, ${createdAt}, ${reviewedAt})`.execute(
      h.db,
    );
    return id;
  }

  /** Seed only: an effective (or released) withdraw hold of `owner` (B2-05e owns holds). */
  async function seedHold(owner: string, values: { holdUntil?: Date; released?: boolean } = {}) {
    await sql`INSERT INTO app.withdraw_holds
      (id, app_id, user_id, reason, created_by, created_at, hold_until, released_at, released_by)
      VALUES (${randomUUID()}, ${appId}, ${owner}, 'manual', 'admin:synthetic', ${NOW},
        ${values.holdUntil ?? null}, ${values.released === true ? NOW : null},
        ${values.released === true ? 'admin:synthetic' : null})`.execute(h.db);
  }

  /** A committed posting of `ledgerType` for `who` at `at` (+ credits, − debits available). */
  async function post(amount: bigint, at: Date, ledgerType: string, who: Fixture = f) {
    await h.db.transaction().execute((trx) => postOn(trx, who, amount, at, ledgerType));
  }

  /** The payout watermark B2-06c's real EXECUTE reads (alipay, measured 10 minutes before NOW). */
  async function watermark(available: bigint) {
    await sql`INSERT INTO app.payout_watermarks (id, app_id, channel, available_fen, measured_at, entered_by)
      VALUES (${randomUUID()}, ${appId}, 'alipay', ${available},
        ${new Date(NOW.getTime() - 10 * MINUTE)}, 'finance:synthetic')`.execute(h.db);
  }

  async function events(handle: Kysely<DB> = h.db) {
    return handle
      .withSchema('app')
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }

  /** wallet.withdrawal_changed events of `id` with status APPROVED (every W2, human or system). */
  async function approvals(id: string, handle: Kysely<DB> = h.db) {
    return (await events(handle)).filter((e) => {
      const payload = e.payload as Record<string, unknown>;
      return (
        e.name === 'wallet.withdrawal_changed' &&
        payload['withdrawal_id'] === id &&
        payload['status'] === 'APPROVED'
      );
    });
  }

  async function claims(eventId: string) {
    return h.db
      .withSchema('app')
      .selectFrom('processed_events')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('consumer', '=', CONSUMER)
      .execute();
  }

  async function batches() {
    return h.db
      .withSchema('app')
      .selectFrom('payout_batches')
      .select(['id', 'kind', 'created_by'])
      .where('app_id', '=', appId)
      .execute();
  }

  async function batchItems() {
    return h.db
      .withSchema('app')
      .selectFrom('payout_batch_items')
      .select(['batch_id', 'withdrawal_id', 'result', 'reason'])
      .where('app_id', '=', appId)
      .execute();
  }

  /** B2-05e's commands on the same ports (the human reviewer's W2 / W3). */
  function commands() {
    return createWithdrawalCommands(options);
  }

  return {
    ...f,
    appId,
    options,
    risk,
    appeals,
    minors,
    blacklisted,
    logger,
    lockUsers,
    execute,
    respond(next: (batch: ExecuteBatchInput) => ExecuteBatchResult) {
      answer = next;
    },
    consumer,
    realExecute,
    member,
    start,
    seedRiskFlags,
    event,
    row,
    seedReviewed,
    seedHold,
    post,
    watermark,
    events,
    approvals,
    claims,
    batches,
    batchItems,
    commands,
  };
}
export type AutoFixture = Awaited<ReturnType<typeof setup>>;

/** The calls of the fake executeBatch for `id`. */
export function executions(f: AutoFixture, id: string) {
  return f.execute.mock.calls.filter(([, batch]) => batch.members.includes(id));
}

/** The one EXECUTE the consumer must make for an automatic withdrawal (BR-WDR-30 自动路径). */
export function expectOneExecute(f: AutoFixture, id: string, now: Date = NOW) {
  const calls = executions(f, id);
  expect(calls).toHaveLength(1);
  const [trx, batch] = calls[0]!;
  expect((trx as { isTransaction?: boolean }).isTransaction).toBe(true);
  expect(batch).toEqual({ appId: f.appId, members: [id], executorId: SYSTEM, now });
}

/** True once some backend waits on a lock held by backend `holder`. */
async function blockedBy(db: Kysely<DB>, holder: number): Promise<boolean> {
  const result = await sql<{ blocked: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE ${holder}::integer = ANY (pg_blocking_pids(pid))
    ) AS blocked`.execute(db);
  return result.rows[0]?.blocked === true;
}

/**
 * A lock fence, no timing: `first` runs on its own transaction and keeps it open; `second` (its
 * own transaction or a call that opens one) then starts; `first` commits only once a backend waits
 * on a lock `first` holds, or `second` has already finished without waiting.
 */
export async function fenced<A, B>(
  h: Harness,
  first: (trx: Transaction<DB>) => Promise<A>,
  second: () => Promise<B>,
): Promise<{ first: A; second: B; waited: boolean }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (value: { pid: number; value: A }) => void;
  const ready = new Promise<{ pid: number; value: A }>((resolve) => {
    reached = resolve;
  });
  const holder = h.db.transaction().execute(async (trx) => {
    const value = await first(trx);
    const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    reached({ pid: result.rows[0]!.pid, value });
    await gate;
    return value;
  });
  const held = await Promise.race([
    ready,
    holder.then((): never => {
      throw new Error('fenced: the first transaction ended before the fence');
    }),
  ]);
  let settled = false;
  const outcome = second().then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  let waited = false;
  for (let attempt = 0; attempt < 4000 && !settled && !waited; attempt += 1) {
    waited = await blockedBy(h.observer, held.pid);
    if (!waited) await delay(5);
  }
  release();
  await holder;
  const done = await outcome;
  if (!done.ok) throw done.error;
  return { first: held.value, second: done.value, waited };
}
