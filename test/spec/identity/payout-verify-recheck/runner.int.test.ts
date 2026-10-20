// BR-WDR-02 ⑦, task §9: exercise the new batch driver over real B1-13f CAS and PostgreSQL.
// Every case constructs the new runner in its body: baseline red is NotImplemented.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  INFLIGHT,
  RECHECK,
  deferred,
  fields,
  manualSchedule,
  open,
  owner,
  protectedState,
  reset,
  row,
  seed,
  until,
  workerContext,
  type Attempts,
  type Kit,
  type Runner,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
});
beforeEach(async () => {
  await reset(kit);
});
afterAll(async () => {
  try {
    await kit?.db.destroy();
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-13g#1] 租约内不动，恰满 60 秒接管、记 unknown_at、同轮按原请求标识复核', async () => {
  const f = await owner(kit);
  const active = await seed(kit, f, {
    status: 'reserved',
    unknown_at: null,
    reserved_at: new Date('2026-10-20T03:59:00.001Z'),
  });
  const expired = await seed(kit, f, {
    status: 'reserved',
    unknown_at: null,
    reserved_at: new Date('2026-10-20T03:59:00Z'),
  });
  const before = await protectedState(kit, f);
  expect(await kit.runner().runOnce()).toEqual({ scanned: 2 });
  expect(await row(kit, active.id)).toEqual(active);
  expect(await row(kit, expired.id)).toEqual({
    ...expired,
    status: 'unknown',
    unknown_at: kit.clock.now(),
    row_version: expired.row_version + 1,
    updated_at: kit.clock.now(),
  });
  expect(kit.query).toHaveBeenCalledExactlyOnceWith(expired.vendor_request_id);
  expect(kit.verify).not.toHaveBeenCalled();
  expect(await protectedState(kit, f)).toEqual(before);
});

it.each([
  ['match', 'matched'],
  ['mismatch', 'mismatched'],
  ['not_found', 'expired_unresolved'],
  ['unknown', 'unknown'],
] as const)('[AC-B1-13g#2] 查询 %s 落 %s，仅更新原核验记录且不重发', async (answer, status) => {
  const f = await owner(kit);
  const original = await seed(kit, f);
  const before = await protectedState(kit, f);
  kit.query.mockResolvedValue(answer);
  const runner = kit.runner();
  expect(await runner.runOnce()).toEqual({ scanned: 1 });
  expect(await row(kit, original.id)).toEqual(
    status === 'unknown'
      ? original
      : {
          ...original,
          status,
          resolved_at: kit.clock.now(),
          row_version: original.row_version + 1,
          updated_at: kit.clock.now(),
        },
  );
  expect(kit.query).toHaveBeenCalledExactlyOnceWith(original.vendor_request_id);
  expect(kit.verify).not.toHaveBeenCalled();
  expect(kit.logs().filter((line) => line['level'] === 50)).toEqual([]);
  expect(await protectedState(kit, f)).toEqual(before);
  if (status !== 'unknown') {
    expect(await runner.runOnce()).toEqual({ scanned: 0 });
    expect(kit.query).toHaveBeenCalledTimes(1);
  }
});

it.each([true, false])(
  '[AC-B1-13g#3] 查询能力=%s，unknown_at 满 30 分钟到期且只有一条三字段告警',
  async (available) => {
    const f = await owner(kit);
    const original = await seed(kit, f, {
      unknown_at: new Date('2026-10-20T03:30:00Z'),
      reserved_at: new Date('2026-10-20T03:29:00Z'),
    });
    const before = await protectedState(kit, f);
    const runner = kit.runner({
      verifier: available ? { verify: kit.verify, query: kit.query } : null,
    });
    await runner.runOnce();
    await runner.runOnce();
    expect(await row(kit, original.id)).toMatchObject({
      status: 'expired_unresolved',
      resolved_at: kit.clock.now(),
      row_version: 1,
    });
    const alerts = kit.logs().filter((line) => line['level'] === 50);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!['msg']).toBe('payout_account_verify_expired_unresolved');
    expect(fields(alerts[0]!)).toEqual({
      user_id: f.uid,
      verify_date: '2026-10-20',
      vendor_request_id: original.vendor_request_id,
    });
    expect(kit.query).toHaveBeenCalledTimes(available ? 1 : 0);
    expect(kit.verify).not.toHaveBeenCalled();
    expect(await protectedState(kit, f)).toEqual(before);
  },
);

it('[AC-B1-13g#4] 无供应商跨日复核：期限从 unknown_at 起算，次日到期仍保留前日额度', async () => {
  const f = await owner(kit);
  const original = await seed(kit, f, {
    verify_date: '2026-10-19',
    reserved_at: new Date('2026-10-19T15:58:00Z'),
    unknown_at: new Date('2026-10-19T15:59:00Z'),
  });
  kit.clock.set('2026-10-19T16:28:59.999Z');
  const before = await protectedState(kit, f);
  const runner = kit.runner({ verifier: null });
  await runner.runOnce();
  expect(await row(kit, original.id)).toEqual(original);
  kit.clock.set('2026-10-19T16:29:00Z');
  await runner.runOnce();
  expect(await row(kit, original.id)).toMatchObject({
    status: 'expired_unresolved',
    resolved_at: kit.clock.now(),
    row_version: 1,
  });
  expect(await protectedState(kit, f)).toEqual(before);
  expect(kit.logs().filter((line) => line['level'] === 50)).toHaveLength(1);
  expect(kit.query).not.toHaveBeenCalled();
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#5] 按行应用新读配置，120 秒租约与 5 分钟复核立即生效且不串 app', async () => {
  const a = await owner(kit);
  const b = await owner(kit);
  const ar = await seed(kit, a, {
    status: 'reserved',
    unknown_at: null,
    reserved_at: new Date('2026-10-20T03:58:30Z'),
  });
  const br = await seed(kit, b, {
    status: 'reserved',
    unknown_at: null,
    reserved_at: new Date('2026-10-20T03:58:30Z'),
  });
  const au = await seed(kit, a, { unknown_at: new Date('2026-10-20T03:55:00Z') });
  const bu = await seed(kit, b, { unknown_at: new Date('2026-10-20T03:55:00Z') });
  kit.values.set(`${a.appId}:${INFLIGHT}`, 120);
  kit.values.set(`${a.appId}:${RECHECK}`, 5);
  const runner = kit.runner();
  await runner.runOnce();
  expect(await row(kit, ar.id)).toEqual(ar);
  expect(await row(kit, br.id)).toMatchObject({ status: 'unknown', row_version: 1 });
  expect(await row(kit, au.id)).toMatchObject({ status: 'expired_unresolved', row_version: 1 });
  expect(await row(kit, bu.id)).toEqual(bu);
  kit.values.set(`${a.appId}:${INFLIGHT}`, 60);
  kit.values.set(`${b.appId}:${RECHECK}`, 5);
  await runner.runOnce();
  expect(await row(kit, ar.id)).toMatchObject({ status: 'unknown', row_version: 1 });
  expect(await row(kit, bu.id)).toMatchObject({ status: 'expired_unresolved', row_version: 1 });
  expect(kit.config.configValue).toHaveBeenCalledWith(a.appId, INFLIGHT, kit.db);
  expect(kit.config.configValue).toHaveBeenCalledWith(b.appId, RECHECK, kit.db);
  expect(kit.verify).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, '120', undefined])(
  '[AC-B1-13g#6] 非法/缺失配置 %s 回退 60 秒和 30 分钟，warn 只含 config_key',
  async (bad) => {
    const f = await owner(kit);
    kit.values.set(`${f.appId}:${INFLIGHT}`, bad);
    kit.values.set(`${f.appId}:${RECHECK}`, bad);
    const reserved = await seed(kit, f, {
      status: 'reserved',
      unknown_at: null,
      reserved_at: new Date('2026-10-20T03:59:00Z'),
    });
    const young = await seed(kit, f, { unknown_at: new Date('2026-10-20T03:30:00.001Z') });
    const due = await seed(kit, f, { unknown_at: new Date('2026-10-20T03:30:00Z') });
    await kit.runner().runOnce();
    expect(await row(kit, reserved.id)).toMatchObject({ status: 'unknown', row_version: 1 });
    expect(await row(kit, young.id)).toEqual(young);
    expect(await row(kit, due.id)).toMatchObject({ status: 'expired_unresolved', row_version: 1 });
    const warnings = kit.logs().filter((line) => line['level'] === 40);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.map(fields)).toEqual(
      expect.arrayContaining([{ config_key: INFLIGHT }, { config_key: RECHECK }]),
    );
    for (const warning of warnings) {
      expect(Object.keys(fields(warning))).toEqual(['config_key']);
    }
    expect(kit.verify).not.toHaveBeenCalled();
  },
);

it('[AC-B1-13g#7] 两 runner 同时查询到期 unknown，只有一方 CAS 落终态和告警', async () => {
  const f = await owner(kit);
  const original = await seed(kit, f, { unknown_at: new Date('2026-10-20T03:30:00Z') });
  const a = kit.runner();
  const b = kit.runner();
  const held = deferred<'unknown'>();
  kit.query.mockImplementation(() => held.promise);
  const pending = Promise.all([a.runOnce(), b.runOnce()]);
  try {
    await until(() => kit.query.mock.calls.length === 2);
    expect(kit.query.mock.calls).toEqual([
      [original.vendor_request_id],
      [original.vendor_request_id],
    ]);
  } finally {
    held.resolve('unknown');
    await pending;
  }
  expect(await row(kit, original.id)).toMatchObject({
    status: 'expired_unresolved',
    row_version: 1,
  });
  expect(kit.logs().filter((line) => line['level'] === 50)).toHaveLength(1);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#8] 两 runner 接管同一 reserved，只递增一次版本且保持第一次 unknown_at', async () => {
  const f = await owner(kit);
  const original = await seed(kit, f, { status: 'reserved', unknown_at: null });
  const a = kit.runner();
  const b = kit.runner();
  await Promise.all([a.runOnce(), b.runOnce()]);
  expect(await row(kit, original.id)).toMatchObject({
    status: 'unknown',
    row_version: 1,
    unknown_at: kit.clock.now(),
  });
  const taken = await row(kit, original.id);
  kit.clock.set('2026-10-20T04:01:00Z');
  await a.runOnce();
  expect(await row(kit, original.id)).toEqual(taken);
  expect(kit.query.mock.calls.every(([id]) => id === original.vendor_request_id)).toBe(true);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#9] 请求侧先 CAS 到 mismatched 时，后台迟到 match 放弃且不重读重试', async () => {
  const f = await owner(kit);
  const original = await seed(kit, f);
  const runner = kit.runner();
  const held = deferred<'match'>();
  kit.query.mockImplementation(() => held.promise);
  const pending = runner.runOnce();
  try {
    await until(() => kit.query.mock.calls.length === 1);
    // Model the request's winning status + version CAS while the background is at the supplier.
    // NOWAIT also proves the worker does not hold a users lock across that call.
    await kit.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx);
      await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', f.uid)
        .forUpdate()
        .noWait()
        .execute();
      const updated = await trx
        .updateTable('payout_account_verify_attempts')
        .set({
          status: 'mismatched',
          row_version: original.row_version + 1,
          resolved_at: kit.clock.now(),
          updated_at: kit.clock.now(),
        })
        .where('app_id', '=', f.appId)
        .where('id', '=', original.id)
        .where('status', '=', 'unknown')
        .where('row_version', '=', original.row_version)
        .executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);
    });
  } finally {
    held.resolve('match');
    await pending;
  }
  expect(await row(kit, original.id)).toMatchObject({ status: 'mismatched', row_version: 1 });
  expect(kit.query).toHaveBeenCalledExactlyOnceWith(original.vendor_request_id);
  expect(kit.logs().filter((line) => line['level'] === 50)).toEqual([]);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#10] 所有终态不进入批次，不查询、不修改', async () => {
  const f = await owner(kit);
  const originals = [];
  for (const status of ['matched', 'mismatched', 'expired_unresolved', 'released']) {
    originals.push(await seed(kit, f, { status, resolved_at: kit.clock.now() }));
  }
  expect(await kit.runner().runOnce()).toEqual({ scanned: 0 });
  for (const original of originals) expect(await row(kit, original.id)).toEqual(original);
  expect(kit.query).not.toHaveBeenCalled();
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#11] 供应商 query 抛错只让该行未知，继续同批下一行且不泄露错误正文', async () => {
  const f = await owner(kit);
  const first = await seed(kit, f, { reserved_at: new Date('2026-10-20T03:57:00Z') });
  const second = await seed(kit, f);
  kit.query
    .mockRejectedValueOnce(new Error('synthetic-card-secret'))
    .mockResolvedValueOnce('match');
  await kit.runner().runOnce();
  expect(await row(kit, first.id)).toEqual(first);
  expect(await row(kit, second.id)).toMatchObject({ status: 'matched', row_version: 1 });
  expect(kit.query.mock.calls).toEqual([[first.vendor_request_id], [second.vendor_request_id]]);
  expect(kit.lines.join('')).not.toContain('synthetic-card-secret');
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#12] query 挂起 10 秒后继续同批；迟到结果不能覆写原 unknown', async () => {
  const f = await owner(kit);
  const first = await seed(kit, f, { reserved_at: new Date('2026-10-20T03:57:00Z') });
  const second = await seed(kit, f);
  const runner = kit.runner();
  const held = deferred<'match'>();
  kit.query.mockImplementationOnce(() => held.promise).mockResolvedValueOnce('mismatch');
  // Fake only timeout APIs; PG I/O and the bounded observer keep their real scheduling.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const pending = runner.runOnce();
  try {
    await until(() => kit.query.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    held.resolve('match');
    await Promise.resolve();
    expect(await row(kit, first.id)).toEqual(first);
    expect(await row(kit, second.id)).toMatchObject({ status: 'mismatched', row_version: 1 });
    expect(kit.query.mock.calls).toEqual([[first.vendor_request_id], [second.vendor_request_id]]);
    expect(kit.verify).not.toHaveBeenCalled();
  } finally {
    held.resolve('match');
    vi.useRealTimers();
    await pending;
  }
}, 20_000);

it.each(['takeover', 'recheck'] as const)(
  '[AC-B1-13g#13] 单行 %s 异常只 warn error_name，之后的行仍顺序处理',
  async (method) => {
    const f = await owner(kit);
    const first = await seed(kit, f, { reserved_at: new Date('2026-10-20T03:57:00Z') });
    const second = await seed(kit, f);
    const calls: string[] = [];
    const attempts = {
      takeover: vi.fn(async ({ id }: { appId: string; id: string }) => {
        calls.push(`takeover:${id}`);
        if (id === first.id && method === 'takeover') throw new Error('synthetic-private-row');
      }),
      recheck: vi.fn(async ({ id }: { appId: string; id: string }) => {
        calls.push(`recheck:${id}`);
        if (id === first.id && method === 'recheck') throw new Error('synthetic-private-row');
      }),
    };
    await kit.runner({ attempts }).runOnce();
    expect(calls).toEqual([
      `takeover:${first.id}`,
      ...(method === 'recheck' ? [`recheck:${first.id}`] : []),
      `takeover:${second.id}`,
      `recheck:${second.id}`,
    ]);
    const warnings = kit.logs().filter((line) => line['level'] === 40);
    expect(warnings).toHaveLength(1);
    expect(fields(warnings[0]!)).toEqual({ error_name: 'Error' });
    expect(kit.lines.join('')).not.toContain('synthetic-private-row');
  },
);

it('[AC-B1-13g#14] 按 reserved_at、id 跨 app 排序，batchSize 限量并把正确 app_id/id 传入', async () => {
  const a = await owner(kit);
  const b = await owner(kit);
  const newer = await seed(kit, a, { reserved_at: new Date('2026-10-20T03:59:00Z') });
  const old2 = await seed(kit, a, { id: '00000000-0000-4000-8000-000000000002' });
  const old1 = await seed(kit, b, { id: '00000000-0000-4000-8000-000000000001' });
  const calls: unknown[] = [];
  const attempts: Attempts = {
    takeover: vi.fn(async (subject) => {
      calls.push(['takeover', subject]);
    }),
    recheck: vi.fn(async (subject) => {
      calls.push(['recheck', subject]);
    }),
  };
  expect(await kit.runner({ attempts, batchSize: 2 }).runOnce()).toEqual({ scanned: 2 });
  expect(calls).toEqual([
    ['takeover', { appId: b.appId, id: old1.id }],
    ['recheck', { appId: b.appId, id: old1.id }],
    ['takeover', { appId: a.appId, id: old2.id }],
    ['recheck', { appId: a.appId, id: old2.id }],
  ]);
  expect(await row(kit, newer.id)).toEqual(newer);
  const info = kit.logs().filter((line) => line['level'] === 30);
  expect(info).toHaveLength(1);
  expect(fields(info[0]!)).toEqual({ scanned: 2 });
});

it('[AC-B1-13g#15] 默认每轮至多 100 行，满批只记 scanned，不自行扩容', async () => {
  const f = await owner(kit);
  for (let n = 0; n < 101; n++) await seed(kit, f);
  const attempts = {
    takeover: vi.fn(async () => undefined),
    recheck: vi.fn(async () => undefined),
  };
  expect(await kit.runner({ attempts }).runOnce()).toEqual({ scanned: 100 });
  expect(attempts.takeover).toHaveBeenCalledTimes(100);
  expect(attempts.recheck).toHaveBeenCalledTimes(100);
  const info = kit.logs().filter((line) => line['level'] === 30);
  expect(info).toHaveLength(1);
  expect(fields(info[0]!)).toEqual({ scanned: 100 });
});

it('[AC-B1-13g#16] A 结果迟到 matched，当前 B、变更记录、幂等结果和已占额度原样保留', async () => {
  const f = await owner(kit);
  const original = await seed(kit, f);
  await kit.db
    .insertInto('payout_accounts')
    .values({
      id: crypto.randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      payout_method: 'bank_card',
      bank_card_no_cipher: Buffer.from('synthetic-card-B-cipher'),
      bank_card_hmac: 'synthetic-B',
      bank_name: '示例银行',
      card_bin: '990001',
      payee_name: '测试人',
      is_current: true,
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
    })
    .execute();
  await kit.db
    .insertInto('payout_account_changes')
    .values({
      app_id: f.appId,
      user_id: f.uid,
      old_payout_method: 'bank_card',
      new_payout_method: 'bank_card',
      old_hmac: 'synthetic-old',
      new_hmac: 'synthetic-B',
      operator: f.uid,
      changed_at: kit.clock.now(),
    })
    .execute();
  await kit.db
    .insertInto('idempotency_keys')
    .values({
      app_id: f.appId,
      user_id: f.uid,
      subject: f.uid,
      method: 'PUT',
      path: '/v1/me/payout-account',
      key: original.idempotency_key!,
      request_hash: 'synthetic-hash',
      status: 'completed',
      response: { code: 50401 },
      expire_at: new Date('2026-10-21T04:00:00Z'),
    })
    .execute();
  const before = await protectedState(kit, f);
  kit.query.mockResolvedValue('match');
  await kit.runner().runOnce();
  expect(await row(kit, original.id)).toMatchObject({ status: 'matched', row_version: 1 });
  expect(await protectedState(kit, f)).toEqual(before);
  expect(kit.verify).not.toHaveBeenCalled();
});

it('[AC-B1-13g#17] 停机等当前行完成，行间停止，不能在下一行或池关闭后继续落库', async () => {
  const f = await owner(kit);
  const first = await seed(kit, f, { reserved_at: new Date('2026-10-20T03:57:00Z') });
  const second = await seed(kit, f);
  const runner = kit.runner();
  const held = deferred<'match'>();
  kit.query.mockImplementationOnce(() => held.promise);
  const timer = manualSchedule();
  const control = kit.api.startPayoutVerifyRecheck(
    () => runner,
    kit.logger,
    () => false,
    timer.schedule,
  );
  const pending = timer.fire();
  let stopped = false;
  try {
    await until(() => kit.query.mock.calls.length === 1);
    const stopping = control.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(timer.cancel).toHaveBeenCalledTimes(1);
    held.resolve('match');
    await stopping;
    await pending;
    expect(await row(kit, first.id)).toMatchObject({ status: 'matched', row_version: 1 });
    expect(await row(kit, second.id)).toEqual(second);
    await timer.fire();
    expect(kit.query).toHaveBeenCalledExactlyOnceWith(first.vendor_request_id);
    expect(kit.verify).not.toHaveBeenCalled();
  } finally {
    held.resolve('match');
    await pending;
    await control.stop();
  }
});

it.each(['staging', 'prod'] as const)(
  '[AC-B1-13g#18] %s 的真实 worker 装配无供应商，使用注入配置接管与到期告警',
  async (appEnv) => {
    const f = await owner(kit);
    kit.values.set(`${f.appId}:${INFLIGHT}`, 120);
    kit.values.set(`${f.appId}:${RECHECK}`, 5);
    const reserved = await seed(kit, f, {
      status: 'reserved',
      unknown_at: null,
      reserved_at: new Date('2026-10-20T03:58:30Z'),
    });
    const pending = await seed(kit, f, { unknown_at: new Date('2026-10-20T03:55:00.001Z') });
    const due = await seed(kit, f, { unknown_at: new Date('2026-10-20T03:55:00Z') });
    const before = await protectedState(kit, f);
    const { context } = await workerContext(kit.api, kit, kit.config, appEnv, kit.db);
    try {
      const runner = context.get(kit.api.payoutVerifyRecheckToken()) as Runner;
      expect(runner).toMatchObject({ runOnce: expect.any(Function) });
      await runner.runOnce();
      expect(await row(kit, reserved.id)).toEqual(reserved);
      expect(await row(kit, pending.id)).toEqual(pending);
      expect(await row(kit, due.id)).toMatchObject({
        status: 'expired_unresolved',
        row_version: 1,
      });
      const alerts = kit.logs().filter((line) => line['level'] === 50);
      expect(alerts).toHaveLength(1);
      expect(fields(alerts[0]!)).toEqual({
        user_id: f.uid,
        verify_date: '2026-10-20',
        vendor_request_id: due.vendor_request_id,
      });
      expect(
        kit.logs().filter((line) => line['msg'] === 'bank_card_verifier_unconfigured'),
      ).toHaveLength(1);
      expect(await protectedState(kit, f)).toEqual(before);
    } finally {
      await context.close();
    }
  },
  30_000,
);

it.each(['local', 'test'] as const)(
  '[AC-B1-13g#19] %s 的独立演示供应商查不到 API 请求时直接 expired_unresolved，不伪造共享',
  async (appEnv) => {
    const f = await owner(kit);
    const original = await seed(kit, f);
    const before = await protectedState(kit, f);
    const { context } = await workerContext(kit.api, kit, kit.config, appEnv, kit.db);
    try {
      const runner = context.get(kit.api.payoutVerifyRecheckToken()) as Runner;
      await runner.runOnce();
      expect(await row(kit, original.id)).toMatchObject({
        status: 'expired_unresolved',
        row_version: 1,
        resolved_at: kit.clock.now(),
      });
      expect(kit.logs().filter((line) => line['level'] === 50)).toEqual([]);
      expect(await protectedState(kit, f)).toEqual(before);
    } finally {
      await context.close();
    }
  },
  30_000,
);
