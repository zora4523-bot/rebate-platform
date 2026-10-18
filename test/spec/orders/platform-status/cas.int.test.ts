import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { TableNode, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Global setup supplies the migrated template; this file clones it and queries as couli_app.
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
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, expectAlert, RECEIVED, scenario } from './kit.ts';

it.each([false, true])(
  '[AC-B1-08i#38] 另一连接改变版本后重读一次，重新判定（已推进=%s）',
  async (advanced) => {
    const f = await scenario(db);
    const pipeline = createOrderPipeline({
      ...f.deps,
      updateStep: {
        async apply(trx, current, incoming, ctx) {
          // This is an independent pooled connection after the pipeline read, before its CAS.
          await db
            .updateTable('orders')
            .set({
              row_version: current.row_version + 1,
              est_commission_fen: 444n,
              commission_version: 9,
              ...(advanced ? { platform_status: 'RECEIVED', received_at: at(RECEIVED) } : {}),
            })
            .where('app_id', '=', ctx.app_id)
            .where('order_id', '=', current.order_id)
            .execute();
          return f.step.apply(trx, current, incoming, ctx);
        },
      },
    });
    const outcome = await pipeline.process(f.next({ est_commission_fen: 555n }), f.ctx);
    const after = await f.read();
    if (advanced) {
      expect(outcome).toMatchObject({ kind: 'pending', reason: 'ILLEGAL_TRANSITION' });
      expect(after.orders[0]).toMatchObject({
        platform_status: 'RECEIVED',
        est_commission_fen: 444n,
        commission_version: 9,
        row_version: f.original.row_version + 1,
      });
      expect(after.pending).toEqual([
        expect.objectContaining({
          detail: 'order_illegal_transition P10 RECEIVED→PLATFORM_PAID',
        }),
      ]);
      expect(f.onUpdated).not.toHaveBeenCalled();
      expect(f.publishedOf('order.updated')).toHaveLength(0);
      expect(f.publishedOf('order.created')).toHaveLength(0);
      expectAlert(f, 'order.illegal_transition', {
        reason: 'ILLEGAL_TRANSITION',
        from_status: 'RECEIVED',
      });
    } else {
      expect(outcome).toMatchObject({ kind: 'updated' });
      expect(after.orders[0]).toMatchObject({
        est_commission_fen: 555n,
        commission_version: 10,
        row_version: f.original.row_version + 2,
      });
      expect(f.onUpdated).toHaveBeenCalledTimes(1);
      expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ est_before: 444n, est_after: 555n });
      expect(f.publishedOf('order.updated')).toHaveLength(1);
    }
    const selects = f.queries.filter(
      (q) => /^select /i.test(q.sql) && /from "app"."orders"/i.test(q.sql),
    );
    expect(selects).toHaveLength(2); // existing() read + exactly one reread inside apply().
    expect(after.history).toEqual(f.before.history);
  },
);

it('[AC-B1-08i#39] 两次 CAS 都影响零行则 ORDER_CAS_CONFLICT，无无限重试或旁路写入', async () => {
  const f = await scenario(db);
  let attempts = 0;
  const pipeline = createOrderPipeline({
    ...f.deps,
    updateStep: {
      async apply(trx, current, incoming, ctx) {
        const zeroRows = trx.withPlugin({
          transformQuery(args) {
            if (
              args.node.kind === 'UpdateQueryNode' &&
              args.node.table !== undefined &&
              TableNode.is(args.node.table) &&
              args.node.table.table.identifier.name === 'orders'
            ) {
              attempts += 1;
              // Database fault injection: both CAS statements really affect zero rows.
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
        return f.step.apply(zeroRows, current, incoming, ctx);
      },
    },
  });
  await expect(pipeline.process(f.next({ est_commission_fen: 333n }), f.ctx)).rejects.toThrow(
    'ORDER_CAS_CONFLICT',
  );
  expect(attempts).toBe(2);
  expect(await f.read()).toEqual(f.before);
  expect(f.onUpdated).not.toHaveBeenCalled();
  expect(f.publishedOf('order.updated')).toHaveLength(0);
});
