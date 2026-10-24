// B2-06d rule tests (规划/08 BR-WDR-13 ①–⑤, BR-WDR-14, BR-WDR-17, BR-WDR-28, BR-WDR-09; state
// machine W5 / W6 / W9; 规划/12 §5.4): the payout process's transfer job on a real PostgreSQL with
// the real job queue (an api-entry runtime on the production `payout` and
// `evt.payout-went-negative` queue specs; pgboss.job rows are read with plain SQL), the real
// ledger and event bus, and B2-06b's FakeChannel behind a thin recording wrapper. Only risk's state
// and appeal readers and content's system write of payout.queue_paused are test ports (their own
// SQL belongs to risk / content). Withdrawals in PAYING are seeded by INSERT plus their real
// WITHDRAW:FREEZE voucher (EXECUTE is B2-06c's), attempts by INSERT as couli_payout.
// Database roles: the handler gets the couli_app pool as `db` and the couli_payout pool as
// `attemptsDb` (only couli_payout may insert / complete payout_attempts; only couli_app may post
// vouchers and write config). Observations use a third couli_app pool (`observer`).
// Only *.int.test.ts files import this kit (they create the database). The handler factory is
// called inside each test, before any lock or gate is taken: red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createLedger, type PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import {
  QUEUE_CATALOG,
  type JobHandler,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { JudgementLists } from '../../../../apps/api/src/modules/payout/application/judgement.ts';
import type { TransferResult } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import {
  FakeChannel,
  type FakeCall,
  type FakeStep,
} from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import type {
  PayoutChannel,
  TransferRequest,
} from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import {
  createTransferJob,
  type PayoutQueuePauseInput,
  type TransferJobOptions,
} from '../../../../apps/api/src/modules/payout/jobs/transfer-job.ts';
import type { RiskStateBatchValue } from '../../../../apps/api/src/modules/risk/index.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { setupOn, teardown } from '../../platform/queue/int-kit.ts';
import { fund, seedUser } from '../apply/kit.ts';

/** 2026-10-19 10:00 +08:00. */
export const NOW = new Date('2026-10-19T02:00:00.000Z');
/** Today (+08:00) of NOW starts at 2026-10-18 16:00 UTC. */
export const DAY_START = new Date('2026-10-18T16:00:00.000Z');
export const TIMEOUT = 60_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
/** When the seeded PAYING withdrawals were executed (W4 is B2-06c's). */
export const EXECUTED_AT = new Date(NOW.getTime() - MINUTE);
/** The decrypted payee account the test cipher port returns (neither phone nor e-mail). */
export const LOGON_ID = 'logon_user_2026';
export const PAYEE_NAME = '合成姓名';
/** The alert line of a pause (BR-WDR-17 / BR-WDR-28). */
export const ALERT = 'payout_queue_paused';
export const NEGATIVE_QUEUE = 'evt.payout-went-negative';
/** payout.query_schedule of these tests: the first query 3 minutes after the transfer. */
export const QUERY_SCHEDULE = {
  points_min: [3, 10, 30, 120],
  interval_min: 120,
  manual_after_min: 1440,
};
export const FIRST_QUERY_DELAY_S = 180;
export const SINGLE_CAP = 1_000_000;
export const DAILY_CAP = 100_000_000;
export type Channel = 'alipay' | 'bank_card';

/** Synthetic lists (not verified Alipay codes): FakeChannel judges with them (BR-WDR-28). */
export const LISTS: JudgementLists = {
  definiteFailCodes: ['TEST_CONFIRMED_FAIL'],
  payerSideCodes: ['TEST_PAYER_SIDE'],
  queryStatusMap: { SUCCESS: 'success' },
};

export function successStep(channelOrderId: string, paidAt?: string): FakeStep {
  return paidAt === undefined
    ? { kind: 'response', raw: { code: '10000' }, status: 'SUCCESS', channelOrderId }
    : { kind: 'response', raw: { code: '10000' }, status: 'SUCCESS', channelOrderId, paidAt };
}
export const FAIL_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '40004', subCode: 'TEST_CONFIRMED_FAIL', msg: 'synthetic' },
};
export const PAYER_SIDE_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '40004', subCode: 'TEST_PAYER_SIDE', msg: 'synthetic' },
};
/** A business code in none of the three lists: unknown and pause (BR-WDR-28). */
export const UNLISTED_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '40004', subCode: 'TEST_NOT_IN_ANY_LIST', msg: 'synthetic' },
};
/** 10000 without SUCCESS: unknown, no pause (D10-230). */
export const DEALING_STEP: FakeStep = {
  kind: 'response',
  raw: { code: '10000' },
  status: 'DEALING',
};
export const UNKNOWN_STEP: FakeStep = { kind: 'unknown' };
export const TIMEOUT_STEP: FakeStep = { kind: 'timeout' };

/** The production `payout` queue (exclusive), the negative-balance event queue and dead letters. */
const CATALOG = QUEUE_CATALOG.filter(
  (spec) => spec.name === 'payout' || spec.name === 'dead-letter' || spec.name === NEGATIVE_QUEUE,
);

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
    /** couli_app: the handler's business handle and the seeds. */
    db: createDb({ connectionString: app, max: 8 }),
    /** couli_app: observations from another connection. */
    observer: createDb({ connectionString: app, max: 3 }),
    /** couli_payout: the handler's attempts handle and attempt seeds. */
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 3 }),
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
  fee?: bigint;
  tax?: bigint;
  channel?: Channel;
  status?: 'APPROVED' | 'PAYING' | 'PAID_API' | 'FAILED' | 'REJECTED';
  executeSeq?: number;
  blockedReason?: 'NEGATIVE_BALANCE';
  appId?: string;
}

export interface Seeded {
  id: string;
  appId: string;
  userId: string;
  outBizNo: string;
  channel: Channel;
  net: bigint;
  amount: bigint;
  executeSeq: number;
  batchId: string;
}

export interface ScriptedChannel {
  fake: FakeChannel;
  channel: PayoutChannel;
  transfers(): TransferRequest[];
}

export interface ChannelHooks {
  /** Runs before the fake sees the request (observations of the record-then-send order). */
  before?: (request: TransferRequest) => Promise<void>;
  /** Runs after the fake recorded the call, before its result is returned (in-flight gates). */
  after?: (request: TransferRequest) => Promise<void>;
  /** Overrides the latency the fake reports (it always reports 0). */
  latencyMs?: number;
}

/** FakeChannel with transfer scripts per out_biz_no, behind a recording wrapper. */
export function scripted(
  steps: Readonly<Record<string, readonly FakeStep[]>>,
  hooks: ChannelHooks = {},
): ScriptedChannel {
  const fake = new FakeChannel({
    mode: 'dry_run',
    lists: LISTS,
    script: Object.fromEntries(
      Object.entries(steps).map(
        ([outBizNo, transfer]): [string, { transfer: readonly FakeStep[] }] => [
          outBizNo,
          { transfer },
        ],
      ),
    ),
  });
  const channel: PayoutChannel = {
    async transfer(request) {
      if (hooks.before !== undefined) await hooks.before(request);
      const pending = fake.transfer(request);
      // A scripted timeout rejects; keep it handled while the gate of `after` is awaited.
      pending.catch(() => undefined);
      if (hooks.after !== undefined) await hooks.after(request);
      const result: TransferResult = await pending;
      return hooks.latencyMs === undefined ? result : { ...result, latencyMs: hooks.latencyMs };
    },
    query: (outBizNo) => fake.query(outBizNo),
  };
  return {
    fake,
    channel,
    transfers: () =>
      fake.calls
        .filter((call): call is Extract<FakeCall, { kind: 'transfer' }> => call.kind === 'transfer')
        .map((call) => call.request),
  };
}

export async function setup(h: Harness) {
  const appId = `process_${randomUUID()}`;
  const clock = new FixedClock(NOW);
  const ledger = createLedger({ clock });
  const adminId = randomUUID();
  const risk = new Map<string, RiskStateBatchValue>();
  const appeals = new Map<string, 'frozen' | 'banned'>();
  const send = vi.fn(h.setup.runtime.send.bind(h.setup.runtime));
  const eventBus = createEventBus({ clock, queue: { send }, subscriptions: [] });
  const logger = { info: vi.fn(), warn: vi.fn() };
  /** content's system write stands in here: payout.queue_paused = true on the caller's trx. */
  const pause = vi.fn(async (trx: Transaction<DB>, input: PayoutQueuePauseInput) => {
    const before = await trx
      .withSchema('app')
      .selectFrom('config_items')
      .select('value')
      .where('app_id', '=', input.appId)
      .where('key', '=', 'payout.queue_paused')
      .forUpdate()
      .executeTakeFirst();
    if (before?.value === true) return { changed: false };
    await sql`UPDATE app.config_items SET value = 'true'::jsonb, version = version + 1
      WHERE app_id = ${input.appId} AND key = 'payout.queue_paused'`.execute(trx);
    return { changed: true };
  });
  const decryptPayee = vi.fn((cipher: Buffer, method: string) =>
    cipher.length > 0 && method !== '' ? LOGON_ID : '',
  );
  const options: Omit<TransferJobOptions, 'channels'> = {
    db: h.db,
    attemptsDb: h.payout,
    clock,
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
    lockUsersForUpdate: vi.fn(lockUsersForUpdate),
    queue: { send },
    eventBus,
    decryptPayee,
    pauseQueue: { pause },
    logger,
  };

  async function set(key: string, value: unknown, app = appId) {
    await sql`INSERT INTO app.config_items (app_id,key,value,updated_by)
      VALUES (${app},${key},${JSON.stringify(value)}::jsonb,'synthetic')
      ON CONFLICT (app_id,key) DO UPDATE SET value=EXCLUDED.value, version=app.config_items.version+1`.execute(
      h.db,
    );
  }

  /** A member with a ledger account holding `balance`. */
  async function newUser(balance = 1_000_000n, app = appId) {
    const owner = await seedUser(h.db, app);
    await fund(h.db, ledger, { appId: app, userId: owner }, balance);
    return owner;
  }

  async function seedBatch(app = appId) {
    const id = randomUUID();
    await sql`INSERT INTO app.payout_batches (id, app_id, kind, created_by, created_at)
      VALUES (${id}, ${app}, 'manual', 'finance:synthetic', ${new Date(NOW.getTime() - 2 * MINUTE)})`.execute(
      h.db,
    );
    return id;
  }

  /**
   * A reviewed withdrawal in `status` (default PAYING, execute_seq 1, executed by an admin on a
   * manual batch). APPROVED / PAYING ones hold their amount in frozen through the real
   * WITHDRAW:FREEZE voucher `wd:{id}:FREEZE`.
   */
  async function seedWithdrawal(values: SeedWithdrawal = {}): Promise<Seeded> {
    const id = randomUUID();
    const app = values.appId ?? appId;
    const owner = values.userId ?? userId;
    const net = values.net ?? 1000n;
    const fee = values.fee ?? 0n;
    const tax = values.tax ?? 0n;
    const amount = net + fee + tax;
    const channel = values.channel ?? 'alipay';
    const status = values.status ?? 'PAYING';
    const executed = status === 'PAYING' || status === 'PAID_API' || status === 'FAILED';
    const executeSeq = values.executeSeq ?? (status === 'REJECTED' ? 0 : 1);
    const outBizNo = randomBytes(16).toString('hex');
    const batchId = await seedBatch(app);
    const reviewedAt = new Date(NOW.getTime() - 2 * MINUTE);
    await h.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO app.withdrawals
        (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
         payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no,
         payout_channel, review_mode, reviewer_id, reviewed_at, reject_reason_code, executor_id,
         executed_at, batch_id, execute_seq, blocked_reason, paid_at, channel_order_id, fail_code,
         row_version, created_at, updated_at)
        VALUES (${id}, ${app}, ${owner}, ${amount}, ${fee}, ${tax}, ${net}, 'SERVICE_FEE',
         ${channel}, ${PAYEE_NAME}, ${Buffer.from('synthetic-encrypted-account')},
         ${randomBytes(32).toString('hex')}, ${channel === 'bank_card' ? '合成银行' : null},
         ${status}, ${outBizNo}, ${channel}, 'manual', ${randomUUID()}, ${reviewedAt},
         ${status === 'REJECTED' ? 'OTHER' : null}, ${executed ? adminId : null},
         ${executed ? EXECUTED_AT : null}, ${batchId}, ${executeSeq},
         ${values.blockedReason ?? null}, ${status === 'PAID_API' ? EXECUTED_AT : null},
         ${status === 'PAID_API' ? `SEED${randomBytes(8).toString('hex')}` : null},
         ${status === 'FAILED' ? 'SEED_FAIL' : null}, 2, ${reviewedAt}, ${EXECUTED_AT})`.execute(
        trx,
      );
      if (status !== 'APPROVED' && status !== 'PAYING') return;
      await lockUsersForUpdate(trx, { appId: app, userIds: [owner] });
      const [balance] = await ledger.lockBalances(trx, { appId: app, userIds: [owner] });
      const [built] = buildVouchers('WITHDRAW:FREEZE', {
        withdrawal_id: id,
        user_id: owner,
        withdraw_fen: amount,
      });
      if (balance === undefined || built === undefined) {
        throw new Error('seed: the member has no balance row or FREEZE built no voucher');
      }
      const entries: PostingEntry[] = built.entries.map((entry) => ({
        account: { ownerType: 'user', accountId: balance.account_id },
        sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
        amount_fen: entry.amount_fen,
        ledger_type: entry.ledger_type,
        sub_type: entry.sub_type,
        income_type: null,
      }));
      await ledger.post(trx, {
        appId: app,
        uniqKey: built.uniq_key,
        bizType: 'withdrawal',
        bizId: id,
        operator: 'system',
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: null,
        entries,
      });
    });
    return { id, appId: app, userId: owner, outBizNo, channel, net, amount, executeSeq, batchId };
  }

  /** An attempt row as the payout process would have written it (couli_payout). */
  async function seedAttempt(
    withdrawalId: string,
    kind: 'transfer' | 'query',
    result: 'pending' | 'success' | 'fail' | 'unknown',
    at: Date,
    app = appId,
  ) {
    await sql`INSERT INTO app.payout_attempts (id, app_id, withdrawal_id, kind, request, result, at)
      VALUES (${randomUUID()}, ${app}, ${withdrawalId}, ${kind},
        ${JSON.stringify({ logon_id: 'log**********26' })}::jsonb, ${result}, ${at})`.execute(
      h.payout,
    );
  }

  /** Another withdrawal already sent today (or not): its transfer attempt counts per its result. */
  async function seedSent(values: {
    net: bigint;
    result: 'pending' | 'success' | 'fail' | 'unknown';
    at: Date;
    kind?: 'transfer' | 'query';
    appId?: string;
    userId?: string;
    fee?: bigint;
    tax?: bigint;
    channel?: Channel;
  }) {
    const status =
      values.result === 'success' ? 'PAID_API' : values.result === 'fail' ? 'FAILED' : 'PAYING';
    const seeded = await seedWithdrawal({
      net: values.net,
      status,
      ...(values.appId === undefined ? {} : { appId: values.appId }),
      ...(values.userId === undefined ? {} : { userId: values.userId }),
      ...(values.fee === undefined ? {} : { fee: values.fee }),
      ...(values.tax === undefined ? {} : { tax: values.tax }),
      ...(values.channel === undefined ? {} : { channel: values.channel }),
    });
    await seedAttempt(seeded.id, values.kind ?? 'transfer', values.result, values.at, seeded.appId);
    return seeded;
  }

  async function seedWithdrawHold(owner: string, values: { holdUntil?: Date; released?: boolean }) {
    await sql`INSERT INTO app.withdraw_holds
      (id, app_id, user_id, reason, created_by, created_at, hold_until, released_at, released_by)
      VALUES (${randomUUID()}, ${appId}, ${owner}, 'manual', 'admin:synthetic',
        ${new Date(NOW.getTime() - HOUR)}, ${values.holdUntil ?? null},
        ${values.released === true ? NOW : null},
        ${values.released === true ? 'admin:synthetic' : null})`.execute(h.db);
  }

  /** available_fen of `owner` drops by 1 fen (a committed ADMIN_ADJUST debit). */
  async function makeNegative(owner: string) {
    await h.db.transaction().execute(async (trx) => {
      await lockUsersForUpdate(trx, { appId, userIds: [owner] });
      const [balance] = await ledger.lockBalances(trx, { appId, userIds: [owner] });
      const v = voucher(appId, balance!.account_id, 1n);
      await ledger.post(trx, {
        ...v,
        entries: v.entries.map((e) => ({ ...e, ledger_type: 'ADMIN_ADJUST' })),
      });
    });
  }

  /** The handler (called inside each test: red is the skeleton's NotImplemented). */
  function job(channel: PayoutChannel, extra: Partial<TransferJobOptions> = {}): JobHandler {
    return createTransferJob({
      ...options,
      channels: { alipay: channel, bank_card: channel },
      ...extra,
    });
  }

  /** The payout job EXECUTE enqueued for `w` (overrides: a stale seq, another app, a redelivery). */
  function jobOf(
    w: Seeded,
    overrides: { seq?: number; appId?: string; attempt?: number } = {},
  ): ReceivedJob {
    return Object.freeze({
      id: randomUUID(),
      queue: 'payout',
      name: 'transfer',
      payload: {
        withdrawal_id: w.id,
        execute_seq: overrides.seq ?? w.executeSeq,
        app_id: overrides.appId ?? w.appId,
      },
      attempt: overrides.attempt ?? 1,
    });
  }

  const userId = await newUser();
  await set('payout.enabled', true);
  await set('payout.queue_paused', false);
  for (const channel of ['alipay', 'bank_card'] as const) {
    await set(`payout.channel_enabled.${channel}`, true);
    await set(`payout.channel_paused.${channel}`, false);
  }
  await set('payout.single_cap_fen', SINGLE_CAP);
  await set('payout.daily_cap_fen', DAILY_CAP);
  await set('payout.query_schedule', QUERY_SCHEDULE);
  await set('payout.definite_fail_codes', LISTS.definiteFailCodes);
  await set('payout.payer_side_codes', LISTS.payerSideCodes);
  await set('payout.query_status_map', LISTS.queryStatusMap);

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
    logger,
    pause,
    decryptPayee,
    set,
    newUser,
    seedBatch,
    seedWithdrawal,
    seedAttempt,
    seedSent,
    seedWithdrawHold,
    makeNegative,
    job,
    jobOf,
  };
}
export type ProcessFixture = Awaited<ReturnType<typeof setup>>;

export async function withdrawal(f: ProcessFixture, id: string, db: Kysely<DB> = f.h.observer) {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function attempts(f: ProcessFixture, id: string, db: Kysely<DB> = f.h.observer) {
  return db
    .withSchema('app')
    .selectFrom('payout_attempts')
    .selectAll()
    .where('withdrawal_id', '=', id)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

export interface JobRow {
  queue: string;
  singleton_key: string | null;
  state: string;
  data: { name: string; payload: Record<string, unknown> };
  /** start_after − created_on, whole seconds (the send's delaySeconds). */
  delay_s: number;
}

/** Every job (any queue) whose payload carries this app. */
export async function jobs(f: ProcessFixture, db: Kysely<DB> = f.h.observer): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    SELECT name AS queue, singleton_key, state::text AS state, data,
      round(extract(epoch FROM start_after - created_on))::int AS delay_s
    FROM pgboss.job
    WHERE data->'payload'->>'app_id' = ${f.appId}
    ORDER BY name, singleton_key NULLS LAST, created_on, id`.execute(db);
  return result.rows;
}

export function queryJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.filter((row) => row.queue === 'payout' && row.data.name === 'query');
}

export function negativeJobs(rows: readonly JobRow[]): JobRow[] {
  return rows.filter((row) => row.queue === NEGATIVE_QUEUE);
}

/** Exactly one first query job of (w, seq): key, payload and delay as BR-WDR-14 schedules it. */
export function expectQueryJob(rows: readonly JobRow[], w: Seeded, seq = w.executeSeq) {
  expect(queryJobs(rows)).toEqual([
    {
      queue: 'payout',
      singleton_key: `${w.id}:${seq}:query:0`,
      state: 'created',
      data: {
        name: 'query',
        payload: { withdrawal_id: w.id, execute_seq: seq, app_id: w.appId, point: 0 },
      },
      delay_s: FIRST_QUERY_DELAY_S,
    },
  ]);
}

/** wallet.withdrawal_changed events of this app (payloads only). */
export async function changes(f: ProcessFixture, db: Kysely<DB> = f.h.observer) {
  const rows = await db
    .withSchema('app')
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', f.appId)
    .where('name', '=', 'wallet.withdrawal_changed')
    .orderBy('id')
    .execute();
  return rows.map((row) => row.payload);
}

export interface EntryRow {
  owner_type: string;
  subject: string;
  sub_account: string;
  amount_fen: bigint;
  ledger_type: string;
}

/** The entries of the voucher `uniqKey` (sorted by ledger type, then owner, then sign). */
export async function entries(
  f: ProcessFixture,
  uniqKey: string,
  db: Kysely<DB> = f.h.observer,
): Promise<EntryRow[]> {
  const result = await sql<EntryRow>`
    SELECT a.owner_type, a.subject, e.sub_account, e.amount_fen, e.ledger_type
    FROM app.ledger_vouchers v
    JOIN app.ledger_entries e ON e.voucher_id = v.id AND e.app_id = v.app_id
    JOIN app.ledger_accounts a ON a.id = e.account_id
    WHERE v.app_id = ${f.appId} AND v.uniq_key = ${uniqKey}
    ORDER BY e.ledger_type, a.owner_type DESC, a.subject, e.amount_fen DESC`.execute(db);
  return result.rows;
}

/** The uniq keys of this app's withdrawal vouchers (wd:{id}:FREEZE / PAID / RETURN). */
export async function withdrawalVouchers(f: ProcessFixture, db: Kysely<DB> = f.h.observer) {
  const rows = await db
    .withSchema('app')
    .selectFrom('ledger_vouchers')
    .select('uniq_key')
    .where('app_id', '=', f.appId)
    .where('uniq_key', 'like', 'wd:%')
    .orderBy('uniq_key')
    .execute();
  return rows.map((row) => row.uniq_key);
}

export async function balanceOf(f: ProcessFixture, userId: string, db: Kysely<DB> = f.h.observer) {
  const [row] = await f.ledger.getBalances(db, { appId: f.appId, userIds: [userId] });
  if (row === undefined) throw new Error('no balance row');
  return { available_fen: row.available_fen, frozen_fen: row.frozen_fen };
}

export async function configOf(f: ProcessFixture, key: string, db: Kysely<DB> = f.h.observer) {
  const row = await db
    .withSchema('app')
    .selectFrom('config_items')
    .select('value')
    .where('app_id', '=', f.appId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** Everything the transfer job may change, for this app. */
export async function snapshot(f: ProcessFixture, db: Kysely<DB> = f.h.observer) {
  return {
    withdrawals: await db
      .withSchema('app')
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    attempts: await db
      .withSchema('app')
      .selectFrom('payout_attempts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    jobs: await jobs(f, db),
    events: await db
      .withSchema('app')
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    vouchers: await db
      .withSchema('app')
      .selectFrom('ledger_vouchers')
      .select(['uniq_key', 'biz_id'])
      .where('app_id', '=', f.appId)
      .orderBy('uniq_key')
      .execute(),
    balances: await db
      .withSchema('app')
      .selectFrom('account_balances')
      .select(['account_id', 'available_fen', 'frozen_fen'])
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    config: await db
      .withSchema('app')
      .selectFrom('config_items')
      .select(['key', 'value', 'version'])
      .where('app_id', '=', f.appId)
      .orderBy('key')
      .execute(),
  };
}

/** The key of BR-WDR-13 ③'s lock: pg_advisory_xact_lock(hashtext('payout_daily:' || app_id)). */
export function dailyLockKey(appId: string): string {
  return `payout_daily:${appId}`;
}

/** True when another connection can take the daily lock right now (nobody holds it). */
export async function dailyLockFree(f: ProcessFixture): Promise<boolean> {
  return f.h.observer.transaction().execute(async (trx) => {
    const result = await sql<{ ok: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtext(${dailyLockKey(f.appId)})) AS ok`.execute(trx);
    return result.rows[0]?.ok === true;
  });
}

/**
 * Holds the daily lock on an observer connection until `release()`; `pid` is its backend.
 * Take it only after the handler is built (a NotImplemented factory must not leave it open).
 */
export async function holdDailyLock(f: ProcessFixture) {
  let unlock!: () => void;
  const unlocked = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let reached!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    reached = resolve;
  });
  const holder = f.h.observer.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${dailyLockKey(f.appId)}))`.execute(trx);
    const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    reached(result.rows[0]!.pid);
    await unlocked;
  });
  const pid = await Promise.race([
    ready,
    holder.then((): never => {
      throw new Error('holdDailyLock: the holder ended before the lock was taken');
    }),
  ]);
  return {
    pid,
    async release() {
      unlock();
      await holder;
    },
  };
}

/** Polls (no timing assumption beyond the bound) until some backend waits on a lock of `holder`. */
export async function waitBlockedBy(f: ProcessFixture, holder: number): Promise<boolean> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = await sql<{ blocked: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE ${holder}::integer = ANY (pg_blocking_pids(pid))
      ) AS blocked`.execute(f.h.observer);
    if (result.rows[0]?.blocked === true) return true;
    await delay(5);
  }
  return false;
}

/**
 * Polls (bounded, no timing assumption) until some backend of this database waits on a lock held
 * by another backend (a row lock, the daily advisory lock, whichever the job takes first).
 */
export async function waitAnyBlocked(f: ProcessFixture): Promise<boolean> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = await sql<{ blocked: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      ) AS blocked`.execute(f.h.observer);
    if (result.rows[0]?.blocked === true) return true;
    await delay(5);
  }
  return false;
}

/**
 * A config reader that stops the first read of `key` until `resume.open()`: with key
 * 'payout.enabled' (the review's first check, BR-WDR-13 ③) the job is then past ① and ②, inside
 * the daily lock, before ④. `inside` opens when that read starts; later reads pass straight through.
 */
export function pauseFirstRead(f: ProcessFixture, key: string) {
  const inside = gate();
  const resume = gate();
  let reads = 0;
  const config: TransferJobOptions['config'] = {
    async configValue(app, item, handle) {
      if (item === key) {
        reads += 1;
        if (reads === 1) {
          inside.open();
          await resume.wait();
        }
      }
      return f.options.config.configValue(app, item, handle);
    },
  };
  return { config, inside, resume };
}

/** Resolves true once `inside` opened, false if `run` settled first (it never reached the read). */
export async function reachedBefore(inside: { wait(): Promise<void> }, run: Promise<unknown>) {
  return Promise.race([
    inside.wait().then(() => true),
    run.then(
      () => false,
      () => false,
    ),
  ]);
}

/** Polls `check` until it holds (bounded); returns whether it did. */
export async function waitUntil(check: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    if (await check()) return true;
    await delay(5);
  }
  return false;
}

/** A gate: `wait()` resolves once `open()` was called. */
export function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open: () => release(), wait: () => opened };
}

/** No log line of the job carries the payee's account or name (BR-WDR-13; AGENTS.md rule 8). */
export function expectNoPayeeInLogs(f: ProcessFixture) {
  const lines = JSON.stringify(
    [...f.logger.info.mock.calls, ...f.logger.warn.mock.calls],
    (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  expect(lines).not.toContain(LOGON_ID);
  expect(lines).not.toContain(PAYEE_NAME);
}
