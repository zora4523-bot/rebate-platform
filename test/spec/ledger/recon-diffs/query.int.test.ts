import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  getReconDiffs,
  type ReconDiffSelection,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { TIMEOUT, INSTANT, close, open, rows, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function seed(
  db: Kysely<DB>,
  appId: string,
  refId: string,
  status: NonNullable<ReconDiffSelection['status']> = 'open',
  refType = 'order',
) {
  return db
    .withSchema('app')
    .insertInto('recon_diffs')
    .values({
      id: randomUUID(),
      app_id: appId,
      type: 'platform_restore',
      source: 'R1',
      period: '2032-06',
      ref_type: refType,
      ref_id: refId,
      expected_fen: 9007199254740993n,
      actual_fen: 9007199254740992n,
      diff_fen: 1n,
      status,
      resolution: { evidence: refId },
      created_at: INSTANT,
      updated_at: INSTANT,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

it('[AC-B2-04k#8] 查询按 app、状态、订单键交集筛选，不将其他引用类型当作订单', async () => {
  const appId = `query-${randomUUID()}`;
  const orderKey = `taobao:${randomUUID()}`;
  const wanted = await seed(h.db, appId, orderKey);
  const closed = await seed(h.db, appId, `${orderKey}-closed`, 'closed');
  const account = await seed(h.db, appId, `${orderKey}-account`, 'open', 'account');
  await seed(h.db, `${appId}-other`, orderKey);
  const all = await getReconDiffs(h.reader, { appId });
  expect([...all].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    [wanted, closed, account].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(await getReconDiffs(h.reader, { appId, status: 'closed' })).toEqual([closed]);
  expect(await getReconDiffs(h.reader, { appId, orderKey })).toEqual([wanted]);
  expect(await getReconDiffs(h.reader, { appId, status: 'open', orderKey })).toEqual([wanted]);
  expect(await getReconDiffs(h.reader, { appId, status: 'closed', orderKey })).toEqual([]);
  expect(await getReconDiffs(h.reader, { appId, orderKey: account.ref_id })).toEqual([]);
  expect(await getReconDiffs(h.reader, { appId: `${appId}-empty` })).toEqual([]);
});

it.each(['open', 'processing', 'adjusted', 'written_off', 'closed'] as const)(
  '[AC-B2-04k#9] 只读角色与只读事务可读取 %s，不锁行、不更新记录',
  async (status) => {
    const appId = `readonly-${randomUUID()}`;
    const row = await seed(h.db, appId, randomUUID(), status);
    await h.reader.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      expect(await getReconDiffs(trx, { appId, status })).toEqual([row]);
      expect(await getReconDiffs(trx, { appId, status })).toEqual([row]);
    });
    expect(await rows(h.db, appId)).toEqual([row]);
  },
);

it('[AC-B2-04k#10] 查询使用传入事务的未提交行与快照，不另开连接或缓存旧结果', async () => {
  const appId = `snapshot-${randomUUID()}`;
  const abort = new Error('query rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      const row = await seed(trx, appId, randomUUID());
      expect(await getReconDiffs(trx, { appId })).toEqual([row]);
      expect(await getReconDiffs(h.reader, { appId })).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await rows(h.db, appId)).toEqual([]);
  const first = await seed(h.db, appId, randomUUID());
  await h.reader
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      expect(await getReconDiffs(trx, { appId })).toEqual([first]);
      await seed(h.db, appId, randomUUID());
      expect(await getReconDiffs(trx, { appId })).toEqual([first]);
    });
  expect(await getReconDiffs(h.reader, { appId })).toHaveLength(2);
});
