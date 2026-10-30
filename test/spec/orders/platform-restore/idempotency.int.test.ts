// B1-08zc：一次作废 / 扣回只出一张单（编排 9.2 第 3 条）。同一作废期（进入行不变）内重复同步、再次 P9、再次佣金
// 恢复 → 不再登记、不再告警；重新作废（新的进入行）后再被平台恢复 → 新单，键用新进入行的 id。
// 骗法：dedupe 只按 order_key（重新作废后漏单）；每次触发都告警（重复登记也打 warn）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, expectedKeys, expectNotRevived, RECEIVED, scenario } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const UPDATED = { ok: true, value: { kind: 'updated' } } as const;

it('[AC-B1-08zc#16] VOID(REFUND)：P9 出一张单；同一作废期内再失效、再 P9 不再登记、不再告警；重新作废后再 P9 → 第二张单，键用新进入行', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'REFUND',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
  });
  const first = expectedKeys(f);

  // ① P9 → PAID：第一张单。
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  expect((await f.diffs()).map((row) => row.dedupe_key)).toEqual([first.dedupeKey]);
  expect(f.restoreWarns()).toHaveLength(1);

  // ② 平台又失效（P6），③ 又恢复到 RECEIVED（P9）：进入行没变 → 不登记、不告警。
  expect(await f.sync({ raw_status: 'invalid' })).toMatchObject(UPDATED);
  expect((await f.order()).platform_status).toBe('INVALID');
  expect(await f.sync({ raw_status: 'received', received_at: at(RECEIVED) })).toMatchObject(
    UPDATED,
  );
  expect((await f.order()).platform_status).toBe('RECEIVED');
  expect(await f.diffs()).toHaveLength(1);
  expect(f.restoreWarns()).toHaveLength(1);
  await expectNotRevived(f, 'VOID', 'REFUND');

  // ④ 运营 ADMIN_RESTORE 恢复（R12），平台再失效，settlement 再作废（新进入行）。
  await f.setRebate('WAITING', 'REFUND');
  await f.addRebateStep({ from: 'VOID', event: 'ADMIN_RESTORE', to: 'WAITING', source: 'admin' });
  expect(await f.sync({ raw_status: 'invalid' })).toMatchObject(UPDATED);
  await f.setRebate('VOID', 'REFUND');
  const reentry = await f.addRebateStep({
    from: 'WAITING',
    event: 'PLATFORM_INVALID',
    to: 'VOID',
  });
  expect(await f.diffs()).toHaveLength(1);

  // ⑤ 平台再恢复（P9 → PAID）：第二张单。
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  const second = expectedKeys(f, reentry);
  const diffs = await f.diffs();
  expect(diffs.map((row) => [row.ref_id, row.dedupe_key])).toEqual([
    [first.refId, first.dedupeKey],
    [second.refId, second.dedupeKey],
  ]);
  expect(diffs.every((row) => row.type === 'platform_restore' && row.status === 'open')).toBe(true);
  const warns = f.restoreWarns();
  expect(warns).toHaveLength(2);
  expect(warns.map((args) => (args[0] as Record<string, unknown>).recon_diff_id)).toEqual(
    diffs.map((row) => row.id),
  );
});

it('[AC-B1-08zc#17] VOID(COMMISSION_ZERO)：佣金 0 → 456 出一张单；同一作废期内佣金再归零、再恢复 → 不再登记、不再告警', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
    imported: 'paid',
    est: 0n,
  });
  expect(await f.sync({ est_commission_fen: 456n, commission_fen: 456n })).toMatchObject(UPDATED);
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({ expected_fen: 456n, dedupe_key: expectedKeys(f).dedupeKey });
  for (const est of [0n, 600n, 700n]) {
    expect(await f.sync({ est_commission_fen: est, commission_fen: est })).toMatchObject(UPDATED);
  }
  // 第一张单不被重复登记覆盖（金额仍是首次登记的）。
  expect(await f.diffs()).toEqual(diffs);
  expect(f.restoreWarns()).toHaveLength(1);
  await expectNotRevived(f, 'VOID', 'COMMISSION_ZERO');
});

it('[AC-B1-08zc#18] CLAWED_BACK(REFUND) 平台仍 SETTLED：结算佣金 0 → 1234 出单后，同一扣回期内再 0 → 1500 不再登记；重新扣回后再恢复 → 新单', async () => {
  const f = await scenario(db, {
    rebate: 'CLAWED_BACK',
    reason: 'REFUND',
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    settle: 0n,
  });
  expect(await f.sync({ settle_commission_fen: 1234n })).toMatchObject(UPDATED);
  expect(await f.sync({ settle_commission_fen: 0n })).toMatchObject(UPDATED);
  expect(await f.sync({ settle_commission_fen: 1500n })).toMatchObject(UPDATED);
  expect(await f.diffs()).toHaveLength(1);
  expect(f.restoreWarns()).toHaveLength(1);

  // R13 恢复为 CREDITED，之后再次结算后失效扣回（新进入行），佣金又被平台恢复。
  await f.setRebate('CREDITED', 'REFUND');
  await f.addRebateStep({
    from: 'CLAWED_BACK',
    event: 'ADMIN_RESTORE',
    to: 'CREDITED',
    source: 'admin',
  });
  expect(await f.sync({ settle_commission_fen: 0n })).toMatchObject(UPDATED);
  expect(await f.diffs()).toHaveLength(1);
  await f.setRebate('CLAWED_BACK', 'REFUND');
  const reentry = await f.addRebateStep({
    from: 'CREDITED',
    event: 'INVALID_AFTER_SETTLE',
    to: 'CLAWED_BACK',
  });
  expect(await f.sync({ settle_commission_fen: 1300n })).toMatchObject(UPDATED);
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(2);
  expect(diffs[1]).toMatchObject({
    dedupe_key: expectedKeys(f, reentry).dedupeKey,
    expected_fen: 1300n,
  });
  expect(f.restoreWarns()).toHaveLength(2);
});
