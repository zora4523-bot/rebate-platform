import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createInviteRewardScanner,
  type InviteRewardExpiry,
  type InviteRewardPayout,
} from '../../../../apps/api/src/modules/growth/application/invite-reward.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

// B1-35c has no separate business AC: these local IDs refer to the task's retry requirement.
// Exercise the real scanner with compiled queries and scripted database results, without PG.
// Fail the page query, not expireIfDue: individual row failures are already caught by expiryPass.
const APP = 'expiry-retry-app';
const PAYEE = '00000000-0000-4000-8000-000000009999';
function dueRow(index: number) {
  return {
    qualified_at: new Date('2026-10-01T00:00:00.000Z'),
    app_id: APP,
    invitee_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  };
}
type DueRow = ReturnType<typeof dueRow>;

function fixture(pages: (DueRow[] | Error)[]) {
  const remaining = [...pages];
  const readExpiry = vi.fn(() => {
    const page = remaining.shift() ?? [];
    if (page instanceof Error) throw page;
    return page;
  });
  const readPayout = vi.fn(() => [
    { app_id: APP, invitee_id: PAYEE, triggered_at: new Date('2026-10-22T00:00:00Z') },
  ]);
  const kinds = new WeakMap<object, 'expiry' | 'payout'>();
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery({ node, queryId }) {
          const { sql } = new PostgresQueryCompiler().compileQuery(node, queryId);
          kinds.set(queryId, sql.includes('"qualified_at"') ? 'expiry' : 'payout');
          return node;
        },
        async transformResult({ queryId }) {
          return { rows: kinds.get(queryId) === 'expiry' ? readExpiry() : readPayout() };
        },
      },
    ],
  });
  onTestFinished(() => db.destroy());
  const clock = new FixedClock('2026-10-23T15:00:00.000Z');
  const expireIfDue = vi.fn<InviteRewardExpiry['expireIfDue']>(async () => undefined);
  const process = vi.fn<InviteRewardPayout['process']>(async () => 'processed');
  const logger = createRootLogger(
    { level: 'silent', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
  // Observe the raw arguments before redaction, so the logger cannot hide a scanner leak.
  const error = vi.spyOn(logger, 'error');
  const scanner = createInviteRewardScanner({
    db,
    clock,
    logger,
    expiry: { expireIfDue },
    payout: { process },
  });
  return { scanner, clock, readExpiry, readPayout, expireIfDue, process, error };
}

it('[AC-B1-35c#1] 首次过期查询失败后同日重试，成功后同日不重扫，跨 +08 会计日再扫', async () => {
  const outage = new Error('synthetic-expiry-query-outage');
  const due = dueRow(1);
  const tomorrow = dueRow(2);
  const f = fixture([outage, [due], [tomorrow]]);

  const outcome = await f.scanner.tick().then(() => 'ok', (error: unknown) => error);
  expect(outcome).toBe('ok');
  expect(f.readExpiry).toHaveBeenCalledTimes(1);
  expect(f.expireIfDue).not.toHaveBeenCalled();
  expect(f.readPayout).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledExactlyOnceWith(APP, PAYEE);
  expect(f.error).toHaveBeenCalledExactlyOnceWith(
    { error_class: 'Error' },
    'invite_reward_expiry_scan_failed',
  );

  f.clock.advanceMs(60_000);
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(2);
  expect(f.expireIfDue).toHaveBeenCalledExactlyOnceWith(APP, due.invitee_id);
  expect(f.process).toHaveBeenCalledTimes(2);
  expect(f.process).toHaveBeenLastCalledWith(APP, PAYEE);

  f.clock.set('2026-10-23T15:59:59.999Z');
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(2);
  expect(f.expireIfDue).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledTimes(3);

  f.clock.set('2026-10-23T16:00:00.000Z');
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.expireIfDue).toHaveBeenNthCalledWith(2, APP, tomorrow.invitee_id);
  expect(f.process).toHaveBeenCalledTimes(4);
  f.clock.advanceMs(60_000);
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.expireIfDue).toHaveBeenCalledTimes(2);
  expect(f.process).toHaveBeenCalledTimes(5);
  expect(f.error).toHaveBeenCalledTimes(1);
});

it('[AC-B1-35c#2] 连续查询失败仍可同日重试，空扫描成功也记当天已扫', async () => {
  const outage = new Error('synthetic-expiry-query-outage');
  const f = fixture([outage, outage, []]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await f.scanner.tick().then(() => 'ok', (error: unknown) => error);
    expect(outcome).toBe('ok');
    expect(f.readExpiry).toHaveBeenCalledTimes(attempt + 1);
    expect(f.readPayout).toHaveBeenCalledTimes(attempt + 1);
    expect(f.process).toHaveBeenCalledTimes(attempt + 1);
    expect(f.process).toHaveBeenLastCalledWith(APP, PAYEE);
    expect(f.error).toHaveBeenCalledTimes(attempt + 1);
    expect(f.error).toHaveBeenLastCalledWith(
      { error_class: 'Error' },
      'invite_reward_expiry_scan_failed',
    );
    f.clock.advanceMs(60_000);
  }
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.process).toHaveBeenCalledTimes(3);
  f.clock.advanceMs(60_000);
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.expireIfDue).not.toHaveBeenCalled();
  expect(f.process).toHaveBeenCalledTimes(4);
  expect(f.error).toHaveBeenCalledTimes(2);
});

it('[AC-B1-35c#3] 已处理一整页后下一页查询失败，同日重试仍处理剩余过期资格', async () => {
  // The first 200 due rows fill the current scanner page. Successful expirations disappear
  // from subsequent due queries; only the unprocessed tail remains on the next tick.
  const firstPage = Array.from({ length: 200 }, (_, index) => dueRow(index + 1));
  const tail = dueRow(201);
  const outage = new Error('synthetic-second-page-outage');
  const f = fixture([firstPage, outage, [tail]]);

  const outcome = await f.scanner.tick().then(() => 'ok', (error: unknown) => error);
  expect(outcome).toBe('ok');
  expect(f.readExpiry).toHaveBeenCalledTimes(2);
  expect(f.expireIfDue.mock.calls).toEqual(firstPage.map((row) => [APP, row.invitee_id]));
  expect(f.readPayout).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledExactlyOnceWith(APP, PAYEE);
  expect(f.error).toHaveBeenCalledExactlyOnceWith(
    { error_class: 'Error' },
    'invite_reward_expiry_scan_failed',
  );

  f.clock.advanceMs(60_000);
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.expireIfDue).toHaveBeenCalledTimes(201);
  expect(f.expireIfDue).toHaveBeenLastCalledWith(APP, tail.invitee_id);
  expect(f.process).toHaveBeenCalledTimes(2);
  expect(f.process).toHaveBeenLastCalledWith(APP, PAYEE);
  f.clock.advanceMs(60_000);
  await f.scanner.tick();
  expect(f.readExpiry).toHaveBeenCalledTimes(3);
  expect(f.expireIfDue).toHaveBeenCalledTimes(201);
  expect(f.process).toHaveBeenCalledTimes(3);
  expect(f.error).toHaveBeenCalledTimes(1);
});

it('[AC-B1-35c#4] 过期查询与逐行发放同时失败，各记错误且 tick 正常返回，同日仍可重试', async () => {
  // Synthetic private data must never reach the logger, even before its own redaction.
  const outage = new Error('synthetic-query-failed phone=13800138000 ip=192.0.2.1');
  const payoutOutage = new RangeError('synthetic-payout-failed phone=13800138000');
  const due = dueRow(1);
  const f = fixture([outage, [due]]);
  f.process.mockRejectedValueOnce(payoutOutage);

  const outcome = await f.scanner.tick().then(() => 'ok', (error: unknown) => error);
  expect(outcome).toBe('ok');
  expect(f.readExpiry).toHaveBeenCalledTimes(1);
  expect(f.expireIfDue).not.toHaveBeenCalled();
  expect(f.readPayout).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledExactlyOnceWith(APP, PAYEE);
  expect(f.error.mock.calls).toEqual([
    [{ error_class: 'Error' }, 'invite_reward_expiry_scan_failed'],
    [{ app_id: APP, invitee_id: PAYEE, error_class: 'RangeError' }, 'invite_reward_payout_failed'],
  ]);

  f.clock.advanceMs(60_000);
  await expect(f.scanner.tick()).resolves.toBeUndefined();
  expect(f.readExpiry).toHaveBeenCalledTimes(2);
  expect(f.expireIfDue).toHaveBeenCalledExactlyOnceWith(APP, due.invitee_id);
  expect(f.process).toHaveBeenCalledTimes(2);
  expect(f.process).toHaveBeenLastCalledWith(APP, PAYEE);
  expect(f.error).toHaveBeenCalledTimes(2);

  f.clock.advanceMs(60_000);
  await expect(f.scanner.tick()).resolves.toBeUndefined();
  expect(f.readExpiry).toHaveBeenCalledTimes(2);
  expect(f.expireIfDue).toHaveBeenCalledTimes(1);
  expect(f.process).toHaveBeenCalledTimes(3);
  expect(f.error).toHaveBeenCalledTimes(2);
});
