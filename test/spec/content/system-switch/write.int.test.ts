import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  KEY,
  NOW,
  SEEDED_AT,
  alerts,
  appId,
  databaseHarness,
  fixture,
  seedHistory,
  seedRow,
  snapshot,
} from './kit.ts';

const h = databaseHarness(createTestDatabase);

it('[AC-F1-02zk#1] 无行：调用方事务内首次关闭与历史可见，提交后才告警，系统身份无后台审计', async () => {
  const f = fixture();
  const before = await snapshot(h.db, f.input.appId);
  const result = await h.db.transaction().execute(async (trx) => {
    const result = await f.writer.turnOff(trx, f.input);
    expect(result).toEqual({ key: KEY, changed: true, version: 1, fromValue: null });
    const inside = await snapshot(trx, f.input.appId);
    expect(inside.items).toHaveLength(1);
    expect(inside.versions).toHaveLength(1);
    // Another connection must not see either write before the caller commits.
    expect(await snapshot(h.db, f.input.appId)).toEqual(before);
    expect(alerts(f.lines)).toEqual([]);
    return result;
  });
  const after = await snapshot(h.db, f.input.appId);
  expect(after.items).toEqual([
    expect.objectContaining({
      app_id: f.input.appId,
      key: KEY,
      value: false,
      version: 1,
      row_version: 0,
      updated_by: 'system',
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
    }),
  ]);
  expect(after.versions).toEqual([
    {
      app_id: f.input.appId,
      key: KEY,
      value: false,
      version: 1,
      updated_by: 'system',
      updated_by_admin_id: null,
      reason: 'daily_check:global_difference',
      created_at: new Date(NOW),
    },
  ]);
  expect(after.audits).toEqual(before.audits);
  expect(alerts(f.lines)).toEqual([]);
  f.writer.alertCommitted(f.input, result);
  expect(alerts(f.lines)).toEqual([
    expect.objectContaining({
      level: 40,
      msg: 'config_change_alert',
      key: KEY,
      app_id: f.input.appId,
      actor: 'system',
      source: 'daily_check',
      reason: 'global_difference',
      from_value: null,
      to_value: false,
    }),
  ]);
});

it.each([true, 'false', 0, null, { corrupt: true }, []])(
  '[AC-F1-02zk#2] 已有值 %j（包括坏值）：关闭后共用版本 +1、row_version +1，保留旧历史与创建时间',
  async (value) => {
    const f = fixture();
    await seedRow(h.db, f.input.appId, value);
    await seedHistory(h.db, f.input.appId, 3);
    const before = await snapshot(h.db, f.input.appId);
    f.clock.advanceMs(12_345);
    const result = await h.db.transaction().execute((trx) => f.writer.turnOff(trx, f.input));
    expect(result).toEqual({ key: KEY, changed: true, version: 4, fromValue: value });
    const after = await snapshot(h.db, f.input.appId);
    expect(after.items).toEqual([
      expect.objectContaining({
        value: false,
        version: 4,
        row_version: 8,
        updated_by: 'system',
        created_at: new Date(SEEDED_AT),
        updated_at: f.clock.now(),
      }),
    ]);
    expect(after.versions).toEqual([
      ...before.versions,
      {
        app_id: f.input.appId,
        key: KEY,
        value: false,
        version: 4,
        updated_by: 'system',
        updated_by_admin_id: null,
        reason: 'daily_check:global_difference',
        created_at: f.clock.now(),
      },
    ]);
    expect(after.audits).toEqual(before.audits);
    expect(alerts(f.lines)).toEqual([]);
    f.writer.alertCommitted(f.input, result);
    expect(alerts(f.lines)).toEqual([
      expect.objectContaining({
        level: 40,
        key: KEY,
        actor: 'system',
        app_id: f.input.appId,
        source: f.input.source,
        reason: f.input.reason,
        from_value: value,
        to_value: false,
      }),
    ]);
  },
);

it('[AC-F1-02zk#3] 已是 false 与重复关闭均为空操作：整行、历史、审计不变，提交后也不告警', async () => {
  const f = fixture();
  await seedRow(h.db, f.input.appId, false);
  await seedHistory(h.db, f.input.appId, 2);
  const before = await snapshot(h.db, f.input.appId);
  for (let count = 0; count < 2; count += 1) {
    f.clock.advanceMs(1_000);
    const result = await h.db.transaction().execute((trx) => f.writer.turnOff(trx, f.input));
    expect(result).toEqual({ key: KEY, changed: false, version: 3, fromValue: false });
    f.writer.alertCommitted(f.input, result);
    expect(await snapshot(h.db, f.input.appId)).toEqual(before);
    expect(alerts(f.lines)).toEqual([]);
  }
});

it.each([false, true])(
  '[AC-F1-02zk#4] 调用方回滚（已有行=%s）：关闭及历史随同回滚，始终不告警',
  async (existing) => {
    const f = fixture();
    if (existing) await seedRow(h.db, f.input.appId, true);
    const before = await snapshot(h.db, f.input.appId);
    const rollback = new Error('caller rollback');
    await expect(
      h.db.transaction().execute(async (trx) => {
        const result = await f.writer.turnOff(trx, f.input);
        expect(result.changed).toBe(true);
        expect((await snapshot(trx, f.input.appId)).versions).toHaveLength(1);
        expect(alerts(f.lines)).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot(h.db, f.input.appId)).toEqual(before);
    expect(alerts(f.lines)).toEqual([]);
  },
);

it('[AC-F1-02zk#5] 历史唯一约束失败：关闭不能单独提交，也不能发告警', async () => {
  const f = fixture();
  await seedRow(h.db, f.input.appId, true);
  await seedHistory(h.db, f.input.appId, 4);
  const before = await snapshot(h.db, f.input.appId);
  await expect(
    h.db.transaction().execute((trx) => f.writer.turnOff(trx, f.input)),
  ).rejects.toThrow();
  expect(await snapshot(h.db, f.input.appId)).toEqual(before);
  expect(alerts(f.lines)).toEqual([]);
});

it('[AC-F1-02zk#6] 只关闭指定 app 的指定键，读缓存五秒到期后看到关闭', async () => {
  const f = fixture();
  const other = appId();
  await seedRow(h.db, f.input.appId, true);
  await seedRow(h.db, f.input.appId, true, 8, 'withdraw.enabled');
  await seedRow(h.db, other, true);
  const before = await snapshot(h.db, f.input.appId);
  const otherBefore = await snapshot(h.db, other);
  const reader = createContentReader({ db: h.db, clock: f.clock });
  expect(await reader.configValue(f.input.appId, KEY)).toEqual({ value: true, version: 3 });
  await h.db.transaction().execute((trx) => f.writer.turnOff(trx, f.input));
  f.clock.advanceMs(5_000);
  expect(await reader.configValue(f.input.appId, KEY)).toEqual({ value: false, version: 4 });
  expect(await snapshot(h.db, other)).toEqual(otherBefore);
  const after = await snapshot(h.db, f.input.appId);
  expect(after.items.filter((row) => row.key !== KEY)).toEqual(
    before.items.filter((row) => row.key !== KEY),
  );
  expect(after.versions.map((row) => row.key)).toEqual([KEY]);
  expect(after.audits).toEqual(before.audits);
});
