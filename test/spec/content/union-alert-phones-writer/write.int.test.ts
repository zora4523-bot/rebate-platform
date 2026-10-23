// F1-02zzj §9.3 ①②③⑥: first write, CAS update, same-value write, caller transaction, isolation,
// no audit row and no value in the logs.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  KEY,
  MARK,
  NOW,
  SEEDED_AT,
  appId,
  cipherValue,
  databaseHarness,
  fixture,
  leaked,
  seedRow,
  seedWritten,
  snapshot,
} from './kit.ts';

const h = databaseHarness(createTestDatabase);

it('[AC-F1-02zzj#1] 首写：无行且 expectedVersion=0 → version 1，当前行与历史各一行，值原样，操作人与原因入历史', async () => {
  const f = fixture();
  const id = f.input.appId;
  // Opaque: content stores whatever object union hands over, nested fields included.
  const value = {
    cipher: `v1.${MARK}.first`,
    kid: 'k-2026-10',
    nested: { list: [1, 'two', null, true], empty: {} },
  };
  const before = await snapshot(h.db, id);
  const result = await h.db
    .transaction()
    .execute((trx) => f.writer.write(trx, { ...f.input, value }));
  expect(result).toEqual({ version: 1 });
  const after = await snapshot(h.db, id);
  expect(after.items).toEqual([
    expect.objectContaining({
      app_id: id,
      key: KEY,
      value,
      version: 1,
      row_version: 0,
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
    }),
  ]);
  const updatedBy = after.items[0]?.updated_by;
  expect(updatedBy).toContain(f.adminId);
  expect(after.versions).toEqual([
    {
      app_id: id,
      key: KEY,
      version: 1,
      value,
      updated_by: updatedBy,
      updated_by_admin_id: f.adminId,
      reason: 'add_phone',
      created_at: new Date(NOW),
    },
  ]);
  expect(after.audits).toEqual(before.audits);
  expect(leaked(f.lines)).toEqual([]);
});

it('[AC-F1-02zzj#2] 更新：expectedVersion=当前版本 → version+1、row_version+1，保留创建时间与旧历史，历史多一行', async () => {
  const f = fixture();
  const id = f.input.appId;
  await seedWritten(h.db, id, 3);
  const before = await snapshot(h.db, id);
  f.clock.advanceMs(12_345);
  const value = cipherValue('updated');
  const result = await h.db
    .transaction()
    .execute((trx) =>
      f.writer.write(trx, { ...f.input, value, expectedVersion: 3, reason: 'remove_phone' }),
    );
  expect(result).toEqual({ version: 4 });
  const after = await snapshot(h.db, id);
  expect(after.items).toEqual([
    expect.objectContaining({
      app_id: id,
      key: KEY,
      value,
      version: 4,
      row_version: 8,
      created_at: new Date(SEEDED_AT),
      updated_at: f.clock.now(),
    }),
  ]);
  const updatedBy = after.items[0]?.updated_by;
  expect(updatedBy).toContain(f.adminId);
  expect(after.versions).toEqual([
    ...before.versions,
    {
      app_id: id,
      key: KEY,
      version: 4,
      value,
      updated_by: updatedBy,
      updated_by_admin_id: f.adminId,
      reason: 'remove_phone',
      created_at: f.clock.now(),
    },
  ]);
  expect(after.audits).toEqual(before.audits);
  expect(leaked(f.lines)).toEqual([]);
});

it('[AC-F1-02zzj#3] 值与当前相同也照写新版本：连续三次同值写 → 版本 1、2、3，历史三行', async () => {
  const f = fixture();
  const id = f.input.appId;
  const value = cipherValue('same');
  for (const expectedVersion of [0, 1, 2]) {
    f.clock.advanceMs(1_000);
    const result = await h.db
      .transaction()
      .execute((trx) => f.writer.write(trx, { ...f.input, value, expectedVersion }));
    expect(result).toEqual({ version: expectedVersion + 1 });
  }
  const after = await snapshot(h.db, id);
  expect(after.items).toEqual([expect.objectContaining({ key: KEY, value, version: 3 })]);
  expect(after.versions.map((row) => [row.version, row.value])).toEqual([
    [1, value],
    [2, value],
    [3, value],
  ]);
  expect(after.versions.map((row) => row.created_at)).toEqual([
    new Date(Date.parse(NOW) + 1_000),
    new Date(Date.parse(NOW) + 2_000),
    new Date(Date.parse(NOW) + 3_000),
  ]);
});

it.each([
  ['不传 reason', {}],
  ['reason=null', { reason: null }],
] as const)('[AC-F1-02zzj#4] 原因可空（%s）：历史 reason 为 null，照常写入', async (_label, patch) => {
  const f = fixture();
  const input = {
    appId: f.input.appId,
    value: f.input.value,
    expectedVersion: 0,
    adminId: f.adminId,
    ...patch,
  };
  const result = await h.db.transaction().execute((trx) => f.writer.write(trx, input));
  expect(result).toEqual({ version: 1 });
  const after = await snapshot(h.db, f.input.appId);
  expect(after.versions).toEqual([
    expect.objectContaining({ key: KEY, version: 1, reason: null, updated_by_admin_id: f.adminId }),
  ]);
});

it.each([false, true])(
  '[AC-F1-02zzj#5] 用调用方事务（已有行=%s）：事务内可见、提交前别的连接看不到，调用方回滚后两表都不变',
  async (existing) => {
    const f = fixture();
    const id = f.input.appId;
    if (existing) await seedWritten(h.db, id, 2);
    const before = await snapshot(h.db, id);
    const expectedVersion = existing ? 2 : 0;
    const rollback = new Error('caller rollback');
    await expect(
      h.db.transaction().execute(async (trx) => {
        const result = await f.writer.write(trx, { ...f.input, expectedVersion });
        expect(result).toEqual({ version: expectedVersion + 1 });
        const inside = await snapshot(trx, id);
        expect(inside.items).toEqual([
          expect.objectContaining({ key: KEY, value: f.input.value, version: expectedVersion + 1 }),
        ]);
        expect(inside.versions).toHaveLength(before.versions.length + 1);
        // Another connection must not see either write before the caller commits.
        expect(await snapshot(h.db, id)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot(h.db, id)).toEqual(before);
  },
);

it('[AC-F1-02zzj#6] 键名固定：只写本 app 的 union.auth_alert_phones，同 app 别的键与别的 app 同键都不动', async () => {
  const f = fixture();
  const id = f.input.appId;
  const other = appId();
  await seedWritten(h.db, other, 1);
  await seedRow(h.db, id, cipherValue('days'), 5, 'union.auth_alert_days');
  const before = await snapshot(h.db, id);
  const otherBefore = await snapshot(h.db, other);
  const result = await h.db.transaction().execute((trx) => f.writer.write(trx, f.input));
  expect(result).toEqual({ version: 1 });
  expect(await snapshot(h.db, other)).toEqual(otherBefore);
  const after = await snapshot(h.db, id);
  expect(after.items.map((row) => [row.key, row.version])).toEqual([
    ['union.auth_alert_days', 5],
    [KEY, 1],
  ]);
  expect(after.items.find((row) => row.key !== KEY)).toEqual(before.items[0]);
  expect(after.versions.map((row) => [row.key, row.version])).toEqual([[KEY, 1]]);
  expect(after.audits).toEqual(before.audits);
});
