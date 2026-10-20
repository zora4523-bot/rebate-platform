import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import { TIMEOUT, close, fixture, key, open, snapshot, transfer, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-04h#12] 只读数据库角色及只读事务可重复调用，不锁余额或产生写入', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 25n, key(f, 'CREDIT'));
  const before = await snapshot(h.db, f.appId);
  await h.reader.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
    const first = await getOrderNets(trx, f);
    expect(first).toEqual({
      beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 25n }],
      platform_net_fen: 0n,
      union_receivable_net_fen: 25n,
    });
    expect(await getOrderNets(trx, f)).toEqual(first);
    expect(await snapshot(trx, f.appId)).toEqual(before);
  });
  expect(await snapshot(h.db, f.appId)).toEqual(before);
});

it('[AC-B2-04h#13] 读取调用方未提交凭证，外部连接不可见，调用方回滚后无残留', async () => {
  const f = await fixture(h.db);
  const before = await snapshot(h.db, f.appId);
  const abort = new Error('caller rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      await transfer(trx, f, f.receivable, f.user, 50n, key(f, 'CREDIT'));
      await transfer(trx, f, f.receivable, f.revenue, 20n, { voucher_kind: 'CREDIT' });
      const own = await getOrderNets(trx, f);
      expect(own).toEqual({
        beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 50n }],
        platform_net_fen: 20n,
        union_receivable_net_fen: 70n,
      });
      const outside = await h.reader.transaction().execute((otherTrx) => getOrderNets(otherTrx, f));
      expect(outside).toEqual({
        beneficiaries: [],
        platform_net_fen: 0n,
        union_receivable_net_fen: 0n,
      });
      // A second call must observe additional writes in the very same transaction.
      await transfer(trx, f, f.user, f.receivable, 10n, key(f, 'CLAWBACK'), {
        ledger_type: 'CLAWBACK',
        sub_type: 'PART_REFUND',
      });
      expect(await getOrderNets(trx, f)).toEqual({
        beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 40n }],
        platform_net_fen: 20n,
        union_receivable_net_fen: 60n,
      });
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await snapshot(h.db, f.appId)).toEqual(before);
  const after = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(after).toEqual({ beneficiaries: [], platform_net_fen: 0n, union_receivable_net_fen: 0n });
});

it('[AC-B2-04h#14] 遵循调用方 REPEATABLE READ 快照，不另开事务读取并发提交', async () => {
  const f = await fixture(h.db);
  await transfer(h.db, f, f.receivable, f.user, 50n, key(f, 'CREDIT'));
  await h.reader
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const first = await getOrderNets(trx, f);
      expect(first).toEqual({
        beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 50n }],
        platform_net_fen: 0n,
        union_receivable_net_fen: 50n,
      });
      // A deterministic interleaving: commit on another connection after the first read.
      await h.db.transaction().execute(async (writer) => {
        await transfer(writer, f, f.receivable, f.user, 20n, key(f, 'SETTLE_ADJUST'), {
          ledger_type: 'SETTLE_ADJUST',
          sub_type: 'SETTLE_DIFF',
        });
        await transfer(writer, f, f.receivable, f.revenue, 3n, { voucher_kind: 'FORFEIT' });
      });
      expect(await getOrderNets(trx, f)).toEqual(first);
    });
  const committed = await h.reader.transaction().execute((trx) => getOrderNets(trx, f));
  expect(committed).toEqual({
    beneficiaries: [{ beneficiary_user_id: f.user.owner_id, role: 'self', net_fen: 70n }],
    platform_net_fen: 3n,
    union_receivable_net_fen: 73n,
  });
});
