import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  card,
  close,
  config,
  deferred,
  fixture,
  maintenance,
  open,
  reset,
  seedAttempt,
  state,
  until,
  userLockAvailable,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => reset(kit));
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-13f#40] 后台只接管超租约 reserved，写 unknown_at 与 row_version，不退额度或写账号', async () => {
  const f = await fixture(kit);
  const active = await seedAttempt(kit, f, { cardNo: card(2) });
  const stale = await seedAttempt(kit, f, { reservedAt: '2026-10-18T03:58:59Z' });
  const service = await maintenance(kit);
  await service.takeover({ appId: f.appId, id: active.id });
  await service.takeover({ appId: f.appId, id: stale.id });
  const rows = await f.attempts();
  expect(rows.find((row) => row.id === active.id)).toEqual(active);
  expect(rows.find((row) => row.id === stale.id)).toMatchObject({
    status: 'unknown',
    unknown_at: kit.clock.now(),
    resolved_at: null,
    row_version: stale.row_version + 1,
    vendor_request_id: stale.vendor_request_id,
    verify_date: stale.verify_date,
  });
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  expect(kit.verify).not.toHaveBeenCalled();
  expect(kit.query).not.toHaveBeenCalled();
});

it.each(['match', 'mismatch', 'not_found', 'unknown'] as const)(
  '[AC-B1-13f#41] 后台复核 %s 只改核验记录，不代替用户保存或写业务幂等结果',
  async (outcome) => {
    const f = await fixture(kit);
    const row = await seedAttempt(kit, f, { status: 'unknown' });
    kit.query.mockResolvedValue(outcome);
    const service = await maintenance(kit);
    await service.recheck({ appId: f.appId, id: row.id });
    const stored = (await f.attempts())[0]!;
    expect(stored.status).toBe(
      outcome === 'match'
        ? 'matched'
        : outcome === 'mismatch'
          ? 'mismatched'
          : outcome === 'not_found'
            ? 'expired_unresolved'
            : 'unknown',
    );
    expect(stored.vendor_request_id).toBe(row.vendor_request_id);
    expect(stored.verify_date).toEqual(row.verify_date);
    if (outcome !== 'unknown') {
      expect(stored.resolved_at).toEqual(kit.clock.now());
      expect(stored.row_version).toBe(row.row_version + 1);
    }
    expect(kit.query).toHaveBeenCalledExactlyOnceWith(row.vendor_request_id);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
    expect(await f.idempotency(row.idempotency_key!)).toEqual([]);
  },
);

it.each([true, false])(
  '[AC-B1-13f#42] 到 unknown_at +30 分钟（供应商可查询=%s）终结，保留额度并脱敏告警',
  async (available) => {
    const f = await fixture(kit);
    const row = await seedAttempt(kit, f, { status: 'unknown', unknownAt: '2026-10-18T03:30:00Z' });
    const service = await maintenance(
      kit,
      available ? { verify: kit.verify, query: kit.query } : null,
    );
    await service.recheck({ appId: f.appId, id: row.id });
    expect((await f.attempts())[0]).toMatchObject({
      status: 'expired_unresolved',
      row_version: row.row_version + 1,
      verify_date: row.verify_date,
      resolved_at: kit.clock.now(),
    });
    expect(kit.verify).not.toHaveBeenCalled();
    const errors = kit.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (line) => line['level'] === 50 && line['vendor_request_id'] === row.vendor_request_id,
      );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ user_id: f.uid, verify_date: expect.any(String) });
    for (const field of [
      'request_fingerprint',
      'card_no',
      'id_no',
      'name',
      'idempotency_key',
      'app_id',
    ]) {
      expect(errors[0]).not.toHaveProperty(field);
    }
    expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  },
);

it('[AC-B1-13f#43] 复核查询期间释放 users 锁，过时的 match 不能覆盖另一执行者的终态与 row_version', async () => {
  const f = await fixture(kit);
  const row = await seedAttempt(kit, f, { status: 'unknown' });
  const hold = deferred<'match' | 'mismatch' | 'not_found' | 'unknown'>();
  kit.query.mockImplementation(() => hold.promise);
  const service = await maintenance(kit);
  const pending = service.recheck({ appId: f.appId, id: row.id });
  try {
    await until(() => kit.query.mock.calls.length === 1);
    await userLockAvailable(kit, f);
    await kit.db
      .updateTable('payout_account_verify_attempts')
      .set({
        status: 'mismatched',
        row_version: row.row_version + 1,
        resolved_at: kit.clock.now(),
        updated_at: kit.clock.now(),
      })
      .where('id', '=', row.id)
      .where('status', '=', 'unknown')
      .where('row_version', '=', row.row_version)
      .execute();
  } finally {
    hold.resolve('match');
    await pending;
  }
  expect((await f.attempts())[0]).toMatchObject({
    status: 'mismatched',
    row_version: row.row_version + 1,
  });
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
});

it('[AC-B1-13f#44] 并发接管只有一次 CAS 更新，保留第一个 unknown_at', async () => {
  const f = await fixture(kit);
  const row = await seedAttempt(kit, f, { reservedAt: '2026-10-18T03:58:00Z' });
  const service = await maintenance(kit);
  const subject = { appId: f.appId, id: row.id };
  await Promise.all([service.takeover(subject), service.takeover(subject)]);
  const stored = (await f.attempts())[0]!;
  expect(stored).toMatchObject({
    status: 'unknown',
    unknown_at: kit.clock.now(),
    row_version: row.row_version + 1,
  });
  kit.clock.set('2026-10-18T04:01:00Z');
  await service.takeover(subject);
  expect((await f.attempts())[0]).toEqual(stored);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13f#45] 接管和复核按 app_id 隔离，终态不可重新查询或转移', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit);
  const row = await seedAttempt(kit, f, { status: 'unknown' });
  const terminal = await seedAttempt(kit, f, { status: 'matched', cardNo: card(2) });
  const service = await maintenance(kit);
  await service.takeover({ appId: other.appId, id: row.id });
  await service.recheck({ appId: other.appId, id: row.id });
  await service.takeover({ appId: f.appId, id: terminal.id });
  await service.recheck({ appId: f.appId, id: terminal.id });
  expect((await f.attempts()).find((value) => value.id === row.id)).toEqual(row);
  expect((await f.attempts()).find((value) => value.id === terminal.id)).toEqual(terminal);
  expect(kit.query).not.toHaveBeenCalled();
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13f#46] 配置端口的租约与复核分钟生效；无效值回退 60 秒与 30 分钟', async () => {
  const f = await fixture(kit);
  const service = await maintenance(kit);
  const row = await seedAttempt(kit, f, { reservedAt: '2026-10-18T03:59:30Z' });
  await config(kit, f, 'withdraw.payout_account_verify_inflight_timeout_sec', 20);
  await service.takeover({ appId: f.appId, id: row.id });
  expect((await f.attempts())[0]!.status).toBe('unknown');
  await config(kit, f, 'withdraw.payout_account_verify_recheck_minutes', 1);
  kit.clock.set('2026-10-18T04:01:00Z');
  await service.recheck({ appId: f.appId, id: row.id });
  expect((await f.attempts())[0]!.status).toBe('expired_unresolved');
  const fresh = await seedAttempt(kit, f, { cardNo: card(2), reservedAt: '2026-10-18T04:00:30Z' });
  await config(kit, f, 'withdraw.payout_account_verify_inflight_timeout_sec', 0);
  await service.takeover({ appId: f.appId, id: fresh.id });
  expect((await f.attempts()).find((value) => value.id === fresh.id)!.status).toBe('reserved');
  const unknown = await seedAttempt(kit, f, {
    status: 'unknown',
    cardNo: card(3),
    unknownAt: '2026-10-18T03:59:00Z',
  });
  await config(kit, f, 'withdraw.payout_account_verify_recheck_minutes', '1');
  await service.recheck({ appId: f.appId, id: unknown.id });
  expect((await f.attempts()).find((value) => value.id === unknown.id)!.status).toBe('unknown');
  const warnings = kit.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40)
    .map((line) => line['config_key']);
  expect(warnings).toEqual(
    expect.arrayContaining([
      'withdraw.payout_account_verify_inflight_timeout_sec',
      'withdraw.payout_account_verify_recheck_minutes',
    ]),
  );
});
