// B2-06c rule tests (规划/08 BR-WDR-11 / 12 / 18 / 05; state machine W4): EXECUTE on a real
// PostgreSQL with the real job queue (an api-entry runtime on the production `payout` queue spec;
// pgboss.job rows are read with plain SQL) and the real event bus. Only risk's state and appeal
// readers are in-memory ports (their SQL is risk's own rule tests). Withdrawals, holds, attempts and
// watermark rows are seeded by INSERT: states outside this task are not produced by a fake command.
// Only *.int.test.ts files import this kit (they create the database).
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { QUEUE_CATALOG } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { RiskStateBatchValue } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createPayoutExecute,
  type ExecuteBatchInput,
  type ExecuteBatchResult,
  type PayoutExecute,
  type PayoutExecuteOptions,
} from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import { setupOn, teardown } from '../../platform/queue/int-kit.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { fund, seedUser } from '../apply/kit.ts';

/** 2026-10-19 10:00 +08:00: "today" (+08:00) starts at 2026-10-18T16:00:00.000Z. */
export const NOW = new Date('2026-10-19T02:00:00.000Z');
export const TIMEOUT = 60_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const SYSTEM = 'system:auto_payout';
export type Channel = 'alipay' | 'bank_card';

/** The production `payout` queue spec (exclusive: singletonKey required) and its dead letter queue. */
const CATALOG = QUEUE_CATALOG.filter((spec) => spec.name === 'payout' || spec.name === 'dead-letter');

interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<Database>) {
  const database = await create();
  const setup = setupOn(database, 'api', {
    catalog: CATALOG,
    plan: { api: [], stream: [], admin: [], worker: [], payout: [] },
  });
  await setup.runtime.start();
  const app = database.urlFor('couli_app');
  return {
    database,
    setup,
    db: createDb({ connectionString: app, max: 8 }),
    observer: createDb({ connectionString: app, max: 3 }),
    /** couli_payout: the only role that may insert payout_attempts (seeding only). */
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 1 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await teardown([h.setup]);
  await Promise.all([destroyDb(h.db), destroyDb(h.observer), destroyDb(h.payout)]);
  await h.database.drop();
}

export interface SeedWithdrawal {
  userId?: string;
  net?: bigint;
  channel?: Channel;
  status?: WithdrawalState;
  createdAt?: Date;
  paidAt?: Date;
  batchId?: string | null;
  appId?: string;
  /** amount_fen = net + fee (amount_fen > 0 even for a net of 0). Default 0. */
  fee?: bigint;
  /** Review mode of a reviewed withdrawal (default 'manual'); 'auto' has no reviewer (system W2). */
  reviewMode?: 'auto' | 'manual';
  /** reviewer_id of a manually reviewed withdrawal (default a fresh id). */
  reviewerId?: string;
}

export async function setup(h: Harness, input: { watermarks?: boolean } = {}) {
  const appId = `execute_${randomUUID()}`;
  const clock = new FixedClock(NOW);
  const ledger = createLedger({ clock });
  const adminId = randomUUID();
  const risk = new Map<string, RiskStateBatchValue>();
  const appeals = new Map<string, 'frozen' | 'banned'>();
  const send = vi.fn(h.setup.runtime.send.bind(h.setup.runtime));
  const eventBus = createEventBus({ clock, queue: { send }, subscriptions: [] });
  const options: PayoutExecuteOptions = {
    config: {
      async configValue(app, key, handle) {
        return (
          (await handle
            .withSchema('app')
            .selectFrom('config_items')
            .select(['value', 'version'])
            .where('app_id', '=', app)
            .where('key', '=', key)
            .executeTakeFirst()) ?? null
        );
      },
    },
    risk: {
      async read(_executor, request) {
        return new Map(
          request.userIds.map((id): [string, RiskStateBatchValue] => [
            id,
            risk.get(id) ?? { state: 'normal', frozen_until: null },
          ]),
        );
      },
    },
    appeal: {
      async read(_handle, subject) {
        return appeals.get(subject.userId) ?? null;
      },
    },
    ledger,
    queue: { send },
    eventBus,
    logger: { warn: vi.fn() },
  };

  async function set(key: string, value: unknown, app = appId) {
    await sql`INSERT INTO app.config_items (app_id,key,value,updated_by)
      VALUES (${app},${key},${JSON.stringify(value)}::jsonb,'synthetic')
      ON CONFLICT (app_id,key) DO UPDATE SET value=EXCLUDED.value, version=app.config_items.version+1`.execute(
      h.db,
    );
  }

  /** A member with a ledger account holding `balance` (0: available exactly 0). */
  async function newUser(balance = 100000n, app = appId) {
    const userId = await seedUser(h.db, app);
    await fund(h.db, ledger, { appId: app, userId }, balance);
    return userId;
  }

  async function seedWithdrawal(values: SeedWithdrawal = {}, db: Kysely<DB> = h.db) {
    const id = randomUUID();
    const app = values.appId ?? appId;
    const owner = values.userId ?? userId;
    const net = values.net ?? 100n;
    const channel = values.channel ?? 'alipay';
    const status = values.status ?? 'APPROVED';
    const createdAt = values.createdAt ?? NOW;
    const fee = values.fee ?? 0n;
    const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
    const reviewed = status !== 'PENDING_REVIEW';
    const mode = reviewed ? (values.reviewMode ?? 'manual') : null;
    const reviewer = mode === 'manual' ? (values.reviewerId ?? randomUUID()) : null;
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no, payout_channel,
       review_mode, reviewer_id, reviewed_at, reject_reason_code, paid_at, manual_entry_by,
       manual_confirm_by, batch_id, created_at, updated_at)
      VALUES (${id}, ${app}, ${owner}, ${net + fee}, ${fee}, ${0n}, ${net}, 'SERVICE_FEE', ${channel},
       '合成姓名', ${Buffer.from('synthetic-encrypted-account')}, ${randomBytes(32).toString('hex')},
       ${channel === 'bank_card' ? '合成银行' : null}, ${status}, ${randomBytes(16).toString('hex')},
       ${channel}, ${mode}, ${reviewer},
       ${reviewed ? createdAt : null}, ${status === 'REJECTED' ? 'OTHER' : null},
       ${paid ? (values.paidAt ?? createdAt) : null},
       ${status === 'PAID_MANUAL' ? randomUUID() : null},
       ${status === 'PAID_MANUAL' ? randomUUID() : null},
       ${values.batchId ?? null}, ${createdAt}, ${createdAt})`.execute(db);
    return id;
  }

  async function watermark(
    available: bigint,
    measuredAt: Date,
    channel: Channel = 'alipay',
    app = appId,
  ) {
    await sql`INSERT INTO app.payout_watermarks (id, app_id, channel, available_fen, measured_at, entered_by)
      VALUES (${randomUUID()}, ${app}, ${channel}, ${available}, ${measuredAt}, 'finance:synthetic')`.execute(
      h.db,
    );
  }

  /** An existing batch (e.g. the automatic batch of a withdrawal whose execution was refused). */
  async function seedBatch(kind: 'manual' | 'auto' = 'auto') {
    const id = randomUUID();
    await sql`INSERT INTO app.payout_batches (id, app_id, kind, created_by, created_at)
      VALUES (${id}, ${appId}, ${kind}, ${kind === 'manual' ? 'finance:synthetic' : null}, ${NOW})`.execute(
      h.db,
    );
    return id;
  }

  /** Seed only (W9 belongs to B2-06d): PAYING → APPROVED with a hold reason. */
  async function seedHold(id: string, db: Kysely<DB> = h.db) {
    await sql`UPDATE app.withdrawals SET status = 'APPROVED', hold_reason = 'single_cap',
      hold_at = ${NOW}, row_version = row_version + 1, updated_at = ${NOW}
      WHERE id = ${id} AND status = 'PAYING'`.execute(db);
  }

  async function seedAttempt(
    withdrawalId: string,
    kind: 'transfer' | 'query',
    result: 'pending' | 'success' | 'fail' | 'unknown',
  ) {
    await sql`INSERT INTO app.payout_attempts (id, app_id, withdrawal_id, kind, request, result)
      VALUES (${randomUUID()}, ${appId}, ${withdrawalId}, ${kind},
        ${JSON.stringify({ logon_id: 'z***@example.test' })}::jsonb, ${result})`.execute(h.payout);
  }

  async function seedWithdrawHold(owner: string, values: { holdUntil?: Date; released?: boolean }) {
    await sql`INSERT INTO app.withdraw_holds
      (id, app_id, user_id, reason, created_by, created_at, hold_until, released_at, released_by)
      VALUES (${randomUUID()}, ${appId}, ${owner}, 'manual', 'admin:synthetic', ${NOW},
        ${values.holdUntil ?? null}, ${values.released === true ? NOW : null},
        ${values.released === true ? 'admin:synthetic' : null})`.execute(h.db);
  }

  /**
   * On `trx`: users row lock → lockBalances → a 1-fen ADMIN_ADJUST debit (a member funded with 0
   * drops to available −1). The locks stay held until `trx` ends.
   */
  async function postNegative(trx: Transaction<DB>, owner: string) {
    await lockUsersForUpdate(trx, { appId, userIds: [owner] });
    const [balance] = await ledger.lockBalances(trx, { appId, userIds: [owner] });
    const v = voucher(appId, balance!.account_id, 1n);
    await ledger.post(trx, {
      ...v,
      entries: v.entries.map((e) => ({ ...e, ledger_type: 'ADMIN_ADJUST' })),
    });
  }

  /** available_fen of a member funded with 0 drops to −1 (committed). */
  async function makeNegative(owner: string) {
    await h.db.transaction().execute((trx) => postNegative(trx, owner));
  }

  /** EXECUTE as a transaction body (for `fenced`). */
  function body(
    service: PayoutExecute,
    members: readonly string[],
    extra: Partial<ExecuteBatchInput> = {},
  ) {
    return (trx: Transaction<DB>) =>
      service.executeBatch(trx, { appId, members, executorId: adminId, now: NOW, ...extra });
  }

  /** The factory, called inside each test (red is the skeleton's NotImplemented, never setup). */
  function execute(): PayoutExecute {
    return createPayoutExecute(options);
  }

  async function run(
    service: PayoutExecute,
    members: readonly string[],
    extra: Partial<ExecuteBatchInput> = {},
    db: Kysely<DB> = h.db,
  ): Promise<ExecuteBatchResult> {
    return db.transaction().execute(body(service, members, extra));
  }

  const userId = await newUser();
  await set('payout.enabled', true);
  await set('payout.queue_paused', false);
  await set('payout.watermark_usable_bp', 10000);
  for (const channel of ['alipay', 'bank_card'] as const) {
    await set(`payout.channel_enabled.${channel}`, true);
    await set(`payout.channel_paused.${channel}`, false);
    if (input.watermarks !== false) {
      await watermark(1_000_000_000n, new Date(NOW.getTime() - 10 * MINUTE), channel);
    }
  }

  return {
    h,
    appId,
    adminId,
    userId,
    clock,
    ledger,
    options,
    send,
    risk,
    appeals,
    set,
    newUser,
    seedWithdrawal,
    watermark,
    seedBatch,
    seedHold,
    seedAttempt,
    seedWithdrawHold,
    postNegative,
    makeNegative,
    execute,
    body,
    run,
  };
}
export type ExecuteFixture = Awaited<ReturnType<typeof setup>>;

/** Narrows to the executed result after asserting it. */
export function executed(result: ExecuteBatchResult) {
  expect(result.kind).toBe('executed');
  if (result.kind !== 'executed') throw new Error(`expected executed, got ${result.reason}`);
  return result;
}

export function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

export async function withdrawal(f: ExecuteFixture, id: string, db: Kysely<DB> = f.h.db) {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function items(f: ExecuteFixture, db: Kysely<DB> = f.h.db) {
  const rows = await db
    .withSchema('app')
    .selectFrom('payout_batch_items')
    .select(['batch_id', 'withdrawal_id', 'result', 'reason', 'moved_to_batch_id'])
    .where('app_id', '=', f.appId)
    .execute();
  return rows.sort((a, b) =>
    `${a.batch_id}${a.withdrawal_id}${a.result}`.localeCompare(
      `${b.batch_id}${b.withdrawal_id}${b.result}`,
    ),
  );
}

export async function batches(f: ExecuteFixture, db: Kysely<DB> = f.h.db) {
  return db
    .withSchema('app')
    .selectFrom('payout_batches')
    .select(['id', 'kind', 'created_by'])
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

export interface JobRow {
  singleton_key: string | null;
  state: string;
  data: { name: string; payload: Record<string, unknown> };
}

/** Jobs of the payout queue carrying this app's withdrawals. */
export async function jobs(f: ExecuteFixture, db: Kysely<DB> = f.h.db): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    SELECT singleton_key, state::text AS state, data FROM pgboss.job
    WHERE name = 'payout' AND data->'payload'->>'app_id' = ${f.appId}
    ORDER BY singleton_key`.execute(db);
  return result.rows;
}

export async function events(f: ExecuteFixture, db: Kysely<DB> = f.h.db) {
  return db
    .withSchema('app')
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', f.appId)
    .where('name', '=', 'wallet.withdrawal_changed')
    .orderBy('id')
    .execute();
}

/** What EXECUTE may change: states, execution and batch columns, batches, items, jobs, events. */
export async function snapshot(f: ExecuteFixture, db: Kysely<DB> = f.h.db) {
  const rows = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select([
      'id',
      'status',
      'execute_seq',
      'executor_id',
      'executed_at',
      'batch_id',
      'review_mode',
      'hold_reason',
    ])
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
  return {
    withdrawals: rows,
    batches: await batches(f, db),
    items: await items(f, db),
    jobs: await jobs(f, db),
    events: await events(f, db),
  };
}

/** True once some backend waits on a lock held by backend `holder`. */
async function blockedBy(db: Kysely<DB>, holder: number): Promise<boolean> {
  const result = await sql<{ blocked: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE ${holder}::integer = ANY (pg_blocking_pids(pid))
    ) AS blocked`.execute(db);
  return result.rows[0]?.blocked === true;
}

interface Leg<T> {
  db: Kysely<DB>;
  body: (trx: Transaction<DB>) => Promise<T>;
}

/**
 * A lock fence, no timing: `first` runs its body on its own transaction and keeps it open; `second`
 * then starts on another pool; `first` commits only once a backend waits on a lock `first` holds
 * (or `second` has already finished without waiting). Returns both bodies' results.
 */
export async function fenced<A, B>(
  h: Harness,
  first: Leg<A>,
  second: Leg<B>,
): Promise<{ first: A; second: B }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (value: { pid: number; value: A }) => void;
  const ready = new Promise<{ pid: number; value: A }>((resolve) => {
    reached = resolve;
  });
  const holder = first.db.transaction().execute(async (trx) => {
    const value = await first.body(trx);
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
  const outcome = second.db
    .transaction()
    .execute(second.body)
    .then(
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
    waited = await blockedBy(h.db, held.pid);
    if (!waited) await delay(5);
  }
  release();
  await holder;
  const done = await outcome;
  if (!done.ok) throw done.error;
  return { first: held.value, second: done.value };
}

/** The one payout job of (id, seq): key, name and payload exactly as BR-WDR-12 writes them. */
export function expectJob(f: ExecuteFixture, rows: readonly JobRow[], id: string, seq: number) {
  const matching = rows.filter((row) => row.singleton_key === `${id}:${seq}`);
  expect(matching).toHaveLength(1);
  expect(matching[0]!.data).toEqual({
    name: 'transfer',
    payload: { withdrawal_id: id, execute_seq: seq, app_id: f.appId },
  });
}

/** The PAYING columns written by W4 (BR-WDR-12). */
export async function expectPaying(
  f: ExecuteFixture,
  id: string,
  input: { batchId: string; seq: number; executor: string | null },
) {
  expect(await withdrawal(f, id)).toMatchObject({
    status: 'PAYING',
    execute_seq: input.seq,
    executor_id: input.executor,
    batch_id: input.batchId,
    executed_at: NOW,
  });
}

/** An untouched member: still in `status`, never executed. */
export async function expectUntouched(f: ExecuteFixture, id: string, status: WithdrawalState) {
  expect(await withdrawal(f, id)).toMatchObject({
    status,
    execute_seq: 0,
    executor_id: null,
    executed_at: null,
  });
}
