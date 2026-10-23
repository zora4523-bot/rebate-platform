// B2-05k rule test kit. Real PG through the payout state kit: members from apply/kit.ts
// (seedUser / fund), negative balances as there (users row lock → lockBalances → ADMIN_ADJUST
// debit), recoveries the same way with a REBATE_CREDIT credit. The ledger is the real one with
// payout's recovery port; the entry assembly is the real AppModule over an in-memory queue.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  createLedger,
  type Ledger,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { createBalanceRecoveredHook } from '../../../../apps/api/src/modules/payout/application/balance-recovered.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  Clock,
  JobHandler,
  QueueRuntime,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { NOW } from '../apply/kit.ts';
import { entry, voucher } from '../../ledger/posting/kit.ts';
import type { Fixture } from '../state/kit.ts';

export {
  close,
  open,
  setup,
  seedStatus,
  withdrawal,
  changeAvailable,
  TIMEOUT,
  type Harness,
  type Fixture,
} from '../state/kit.ts';
export { fixture, success, NOW } from '../apply/kit.ts';
export { entry };

/** The recovery port's clock: same day as the fixture's NOW, a different instant. */
export const HOOK_NOW = '2026-10-19T04:05:06.789Z';
/** The assembled entry's clock (its CLOCK provider), again a different instant. */
export const ENTRY_NOW = '2026-10-19T03:04:05.678Z';
export const NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';

/**
 * The real ledger with payout's recovery port. Called inside each test (never in a hook), so on
 * the skeleton every case fails with NotImplemented.
 */
export function recovering() {
  const clock = new FixedClock(NOW);
  const hookClock = new FixedClock(HOOK_NOW);
  const hook = createBalanceRecoveredHook({ clock: hookClock });
  const ledger: Ledger = createLedger({ clock, balanceRecoveredHook: hook });
  return { clock, hookClock, hook, ledger };
}

/** A REBATE_CREDIT voucher crediting the member's available by `credit` fen. */
export function creditVoucher(appId: string, accountId: string, credit: bigint): PostingVoucher {
  // voucher(): the user entry carries the signed liability amount, so a credit is negative.
  return voucher(appId, accountId, -credit);
}

export async function accountOf(f: Fixture): Promise<string> {
  const [row] = await f.ledger.getBalances(f.h.db, {
    appId: f.actor.appId,
    userIds: [f.actor.userId],
  });
  expect(row).toBeDefined();
  return row!.account_id;
}

export async function balanceOf(f: Fixture, db: Kysely<DB> = f.h.db) {
  const [row] = await f.ledger.getBalances(db, {
    appId: f.actor.appId,
    userIds: [f.actor.userId],
  });
  expect(row).toBeDefined();
  return row!;
}

/** users row lock → ledger.lockBalances → run, in one transaction (BR-WDR-07 lock order). */
export async function locked<T>(
  db: Kysely<DB>,
  ledger: Ledger,
  appId: string,
  userIds: readonly string[],
  run: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId, userIds: [...userIds] });
    await ledger.lockBalances(trx, { appId, userIds: [...userIds] });
    return run(trx);
  });
}

/** Seed only: the block as the went-negative consumer leaves it (BR-WDR-05 (a)). */
export async function block(f: Fixture, id: string): Promise<void> {
  await f.h.db
    .withSchema('app')
    .updateTable('withdrawals')
    .set({ blocked_reason: NEGATIVE_BALANCE })
    .where('app_id', '=', f.actor.appId)
    .where('id', '=', id)
    .execute();
}

export async function withdrawalsOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** The app's books and events: vouchers, entries, balances and event_log rows. */
export async function books(db: Kysely<DB>, appId: string) {
  const app = db.withSchema('app');
  return {
    vouchers: await app
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    entries: await app
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    balances: await app
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    events: await app
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Books = Awaited<ReturnType<typeof books>>;

/** The books changed by exactly one posted voucher of `entryCount` entries, nothing else. */
export function expectOnlyVoucher(
  before: Books,
  after: Books,
  voucherId: string,
  entryCount: number,
): void {
  expect(after.vouchers.filter((v) => v.id !== voucherId)).toEqual(before.vouchers);
  expect(after.vouchers.filter((v) => v.id === voucherId)).toHaveLength(1);
  expect(after.entries.filter((e) => e.voucher_id !== voucherId)).toEqual(before.entries);
  expect(after.entries.filter((e) => e.voucher_id === voucherId)).toHaveLength(entryCount);
  expect(after.events).toEqual(before.events);
}

type Entry = 'api' | 'admin' | 'worker' | 'payout';
interface AppContext {
  get(token: unknown, options: { strict: boolean }): unknown;
  close(): Promise<void>;
}

/**
 * The real AppModule of `entry` over `db` and `clock`, with JOB_QUEUE replaced by an in-memory
 * runtime (no polling, sends recorded). URL imports keep the decorated API controllers out of the
 * test project's erasable-only TypeScript (as notification/risk-state-message/worker-kit.ts).
 */
export async function assembled(entryName: Entry, db: Kysely<DB>, clock: Clock) {
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<AppContext>;
    };
  };
  const registrations: Array<{ name: string; handler: JobHandler }> = [];
  const sends = vi.fn<QueueRuntime['send']>(async () => 'fixture-job');
  const queue: QueueRuntime = {
    register(name, handler) {
      registrations.push({ name, handler });
    },
    send: sends,
    async start() {},
    async stop() {},
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  try {
    const context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: entryName,
        config: loadConfig({ APP_ENV: 'test' }),
        clock,
        logger: createRootLogger(
          { level: 'silent', entry: entryName, appEnv: 'test' },
          { write() {} },
        ),
        dbHandles: { db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
    return {
      registrations,
      sends,
      get: (token: unknown) => context.get(token, { strict: false }),
      close: () => context.close(),
    };
  } finally {
    spy.mockRestore();
  }
}

/** The queue job the event bus delivers for account.went_negative (registerEventConsumer). */
export function wentNegativeJob(
  eventId: string,
  appId: string,
  userId: string,
  at: Date,
): Parameters<JobHandler>[0] {
  return {
    id: eventId,
    queue: 'evt.payout-went-negative',
    name: 'account.went_negative',
    payload: { app_id: appId, v: 1, occurred_at: at.toISOString(), data: { user_id: userId } },
    attempt: 1,
  };
}
