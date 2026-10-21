import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { TableNode, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { setup } from '../snapshot-retry/kit.ts';
import { requireFeeColumn, readFee } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08v#16] CAS 两次未命中时不能旁路写服务费，也不调用下游端口', async () => {
  await requireFeeColumn(db);
  const f = await setup(db);
  const before = await f.read();
  const step = createOrderUpdateStep({
    ...f.deps,
    snapshots: f.port,
    events: { publish: f.publish },
    rebate: { onUpdated: f.onUpdated, onUnmappedStatus: vi.fn() },
  });
  let attempts = 0;
  const pipeline = createOrderPipeline({
    ...f.deps,
    snapshots: f.port,
    updateStep: {
      async apply(trx, current, incoming, ctx) {
        // 与 B1-08i 相同的数据库故障注入：真的执行 UPDATE，但 WHERE 恒假。
        const zeroRows = trx.withPlugin({
          transformQuery(args) {
            if (
              args.node.kind === 'UpdateQueryNode' &&
              args.node.table !== undefined &&
              TableNode.is(args.node.table) &&
              args.node.table.table.identifier.name === 'orders'
            ) {
              attempts++;
              return {
                ...args.node,
                where: { kind: 'WhereNode', where: { kind: 'ValueNode', value: false } },
              };
            }
            return args.node;
          },
          async transformResult(args) {
            return args.result;
          },
        });
        return step.apply(zeroRows, current, incoming, ctx);
      },
    },
  });
  await expect(pipeline.process({ ...f.next(), service_fee_fen: 57n }, f.ctx)).rejects.toThrow(
    'ORDER_CAS_CONFLICT',
  );
  expect(attempts).toBe(2);
  expect(await f.read()).toEqual(before);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(31n);
  expect(f.port.create).not.toHaveBeenCalled();
  expect(f.onUpdated).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
