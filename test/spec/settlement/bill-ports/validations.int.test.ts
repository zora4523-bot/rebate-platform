// B2-04zd：账单任务生产 saveValidations。D10-443 (a) 取 B：逐单校验结果不落库，
// 只留 settle_bills 合计与差错单，批次发起时重跑校验；本端口调用不写任何表。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  saveBillValidations,
  type BillJobDependencies,
  type BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import {
  TIMEOUT,
  databaseFixture,
  newApp,
  readOnly,
  seedOrder,
  seedSettlement,
  selection,
  tableCounts,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// 装配形状：直接作为账单任务的 saveValidations 依赖。
const port: BillJobDependencies['saveValidations'] = saveBillValidations;

it(
  '[AC-B2-04zd#9] 取 B：六种校验结果在只读事务里交给端口即完成，各表行数不变',
  async () => {
    const db = database.db;
    const appId = newApp();
    const o = await seedOrder(db, appId);
    await seedSettlement(db, o);
    const row = (
      orderKey: string,
      orderId: string | null,
      result: BillValidation['result'],
      settleSeq: number | null,
    ): BillValidation => ({ orderKey, orderId, result, settleSeq });
    const rows: BillValidation[] = [
      row(o.key, o.orderId, 'candidate', 1),
      row('taobao:synthetic-b', randomUUID(), 'amount_mismatch', 2),
      row('taobao:synthetic-c', randomUUID(), 'deferred', 1),
      row('taobao:synthetic-d', null, 'unexpected_settlement', 1),
      row('taobao:synthetic-e', randomUUID(), 'already_credited', 3),
      row('taobao:synthetic-f', randomUUID(), 'missing_settlement', null),
    ];
    const before = await tableCounts(db, appId);

    const result = await readOnly(db, (trx) => port(trx, selection(appId), rows));

    expect(result).toBeUndefined();
    expect(await tableCounts(db, appId)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#10] 取 B：空结果同样不写、不报错',
  async () => {
    const db = database.db;
    const appId = newApp();
    const before = await tableCounts(db, appId);

    const result = await readOnly(db, (trx) => port(trx, selection(appId, 'jd'), []));

    expect(result).toBeUndefined();
    expect(await tableCounts(db, appId)).toEqual(before);
  },
  TIMEOUT,
);
