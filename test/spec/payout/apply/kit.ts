// Only *.int.test.ts provisions PG, via @couli/db/testing (TEST_PG_ADMIN_URL in CI).
// All balances, locks, usage, idempotency and event_log writes use real PG. Static identity
// prerequisites and the fee calculator are explicit ports, never fake payment/vendor calls.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { createLedger, type Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createWithdrawSubjectReader } from '../../../../apps/api/src/modules/identity/ports/withdraw-subject.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  createWithdrawApply,
  type WithdrawApplyOptions,
  type WithdrawApplyResult,
} from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import { createDefaultFeeTaxCalculator } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { createWithdrawUsageReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-usage.ts';
import { createWithdrawHoldsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-holds.ts';
import { generateOutBizNo } from '../../../../apps/api/src/modules/payout/domain/out-biz-no.ts';
import { voucher } from '../../ledger/posting/kit.ts';

export const NOW = '2026-10-19T02:00:00.000Z';
export const PATH = '/v1/withdrawals';
export const TIMEOUT = 60_000;
export interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
export async function open(create: () => Promise<Database>) {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  return {
    database,
    db: createDb({ connectionString, max: 24 }),
    observer: createDb({ connectionString, max: 3 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;
export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.observer)]);
  await h.database.drop();
}

export async function seedUser(db: Kysely<DB>, appId: string) {
  const userId = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${userId}, ${appId}, 'synthetic', 'synthetic', ${randomUUID()}, ${randomUUID()}, 'L1', 'sms', 'normal')`.execute(
    db,
  );
  return userId;
}

export async function fund(
  db: Kysely<DB>,
  ledger: Ledger,
  actor: { appId: string; userId: string },
  credit: bigint,
) {
  await db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId: actor.appId, userIds: [actor.userId] });
    const account = await ledger.openUserAccount(trx, actor);
    await ledger.lockBalances(trx, { appId: actor.appId, userIds: [actor.userId] });
    if (credit !== 0n) await ledger.post(trx, voucher(actor.appId, account.account_id, -credit));
  });
}

export async function fixture(
  h: Harness,
  input: {
    appId?: string;
    balance?: bigint;
    method?: 'alipay' | 'bank_card';
  } = {},
) {
  const actor = {
    appId: input.appId ?? `apply_${randomUUID()}`,
    userId: '',
    deviceId: randomUUID(),
  };
  actor.userId = await seedUser(h.db, actor.appId);
  const clock = new FixedClock(NOW);
  const ledger = createLedger({ clock });
  await fund(h.db, ledger, actor, input.balance ?? 10000n);
  const method = input.method ?? 'alipay';
  const account = method === 'alipay' ? 'zhang.san@example.test' : '6222021234567890123';
  const cipher = Buffer.from('synthetic-encrypted-account');
  const hmac = randomBytes(32).toString('hex');
  await sql`INSERT INTO app.payout_accounts
    (id,app_id,user_id,payout_method,payee_name,is_current,alipay_hmac,alipay_logon_id_cipher,
     bank_card_hmac,bank_card_no_cipher,bank_name,card_bin)
    VALUES (${randomUUID()},${actor.appId},${actor.userId},${method},'合成姓名',true,
      ${method === 'alipay' ? hmac : null},${method === 'alipay' ? cipher : null},
      ${method === 'bank_card' ? hmac : null},${method === 'bank_card' ? cipher : null},
      ${method === 'bank_card' ? '合成银行' : null},${method === 'bank_card' ? '622202' : null})`.execute(
    h.db,
  );
  const config = {
    async configValue(appId: string, key: string, handle: Kysely<DB>) {
      return (
        (await handle
          .withSchema('app')
          .selectFrom('config_items')
          .select(['value', 'version'])
          .where('app_id', '=', appId)
          .where('key', '=', key)
          .executeTakeFirst()) ?? null
      );
    },
  };
  async function set(key: string, value: unknown) {
    await sql`INSERT INTO app.config_items (app_id,key,value,updated_by)
      VALUES (${actor.appId},${key},${JSON.stringify(value)}::jsonb,'synthetic')
      ON CONFLICT (app_id,key) DO UPDATE SET value=EXCLUDED.value, version=app.config_items.version+1`.execute(
      h.db,
    );
  }
  for (const key of [
    'daily_count_per_user',
    'monthly_count_per_user',
    'payee_daily_count',
    'payee_daily_distinct_users',
  ]) {
    await set(`withdraw.${key}`, 0);
  }
  const bus = createEventBus({
    clock,
    subscriptions: [],
    queue: {
      // No consumers configured: event_log still uses the real bus and caller's transaction.
      send: async () => {
        throw new Error('unexpected queue subscription');
      },
    },
  });
  const options: WithdrawApplyOptions = {
    ledger,
    lockUsersForUpdate,
    outBizNo: () => generateOutBizNo(randomBytes),
    eventBus: bus,
    snapshot: {
      async read(handle, who) {
        const row = await handle
          .withSchema('app')
          .selectFrom('payout_accounts')
          .selectAll()
          .where('app_id', '=', who.appId)
          .where('user_id', '=', who.userId)
          .where('is_current', '=', true)
          .executeTakeFirst();
        if (!row) return null;
        return {
          payout_method: method,
          payee_name: row.payee_name,
          payee_account_cipher: (method === 'alipay'
            ? row.alipay_logon_id_cipher
            : row.bank_card_no_cipher)!,
          payee_hmac: (method === 'alipay' ? row.alipay_hmac : row.bank_card_hmac)!,
          bank_name: row.bank_name,
          account,
        };
      },
    },
    rules: {
      clock,
      logger: { warn: () => undefined },
      config,
      ledger,
      risk: {
        read: async () => new Map([[actor.userId, { state: 'normal', frozen_until: null }]]),
      },
      appeal: { read: async () => null },
      blocklist: { read: async () => null },
      reverify: { check: async () => null },
      realname: {
        read: async () => 'verified',
        verified: async () => ({
          name: '合成姓名',
          birth_date: '1990-01-01',
          provider: 'synthetic',
          verified_at: clock.now(),
        }),
      },
      subject: createWithdrawSubjectReader(),
      laborAgreementSigned: async () => true,
      holds: createWithdrawHoldsReader(),
      usage: createWithdrawUsageReader(),
      selfPurchase: { read: async () => ({ count: 0, amount_fen: 0n }) },
      feeTax: createDefaultFeeTaxCalculator(),
    },
  };
  const idempotency = createIdempotency({ db: h.db, clock, logger: { warn: () => undefined } });
  // Factory is deliberately called by each test, never during suite setup.
  function service() {
    return createWithdrawApply(options);
  }
  async function apply(trx: Transaction<DB>, amountFen = 1000n) {
    return service().apply(trx, { ...actor, amountFen, stepUpValid: true });
  }
  async function request(key = randomUUID(), amountFen = 1000n) {
    const useCase = service();
    return idempotency.executeInTransaction(
      {
        appId: actor.appId,
        actor: { ...actor, phoneHmac: null },
        method: 'POST',
        path: PATH,
        key,
        body: { amount_fen: Number(amountFen) },
        traceId: randomUUID(),
      },
      async (trx) => {
        const result = await useCase.apply(trx, { ...actor, amountFen, stepUpValid: true });
        // Transport-independent integration tests; HTTP suite tests the actual controller mapping.
        return {
          status: result.code === 0 ? 200 : 422,
          envelope: {
            code: result.code,
            msg: '',
            trace_id: actor.userId,
            data: JSON.parse(
              JSON.stringify(result.data, (_k, v: unknown) =>
                typeof v === 'bigint' ? Number(v) : v,
              ),
            ) as unknown,
          },
        };
      },
    );
  }
  return {
    h,
    actor,
    clock,
    ledger,
    options,
    idempotency,
    set,
    service,
    apply,
    request,
    account,
    cipher,
    hmac,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function answer(response: { body: string }) {
  return JSON.parse(response.body) as { code: number; data?: Record<string, unknown> };
}
export function success(result: WithdrawApplyResult) {
  expect(result.code).toBe(0);
  const data = result.data;
  expect(data).toHaveProperty('withdrawal_id');
  return data as import('../../../../packages/contracts-ts/src/index.ts').Schema<'Withdrawal'>;
}
export async function rows(f: Fixture, handle: Kysely<DB> = f.h.db) {
  return handle
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', f.actor.appId)
    .orderBy('id')
    .execute();
}
export async function state(f: Fixture, handle: Kysely<DB> = f.h.db) {
  const db = handle.withSchema('app');
  return {
    withdrawals: await rows(f, handle),
    balances: await f.ledger.getBalances(handle, {
      appId: f.actor.appId,
      userIds: [f.actor.userId],
    }),
    vouchers: await db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .where('biz_type', '=', 'withdrawal')
      .orderBy('id')
      .execute(),
    entries: await db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .where('ledger_type', '=', 'WITHDRAW_FREEZE')
      .orderBy('sub_account')
      .execute(),
    events: await db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .orderBy('name')
      .execute(),
    keys: await db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', f.actor.appId)
      .orderBy('key')
      .execute(),
  };
}
export async function invariant(f: Fixture) {
  const result = await sql<{ frozen: string; pending: string }>`SELECT
    (SELECT COALESCE(sum(frozen_fen),0)::text FROM app.account_balances WHERE app_id=${f.actor.appId}) AS frozen,
    (SELECT COALESCE(sum(amount_fen),0)::text FROM app.withdrawals WHERE app_id=${f.actor.appId}
      AND status IN ('PENDING_REVIEW','APPROVED','PAYING')) AS pending`.execute(f.h.db);
  expect(result.rows[0]!.frozen).toBe(result.rows[0]!.pending);
}
