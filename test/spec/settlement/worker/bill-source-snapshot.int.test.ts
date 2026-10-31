// B2-04ze, FU-B204ZD-SNAPSHOT (B2-04zd money r1 S2; task brief §9.4): the bill job's readSource
// must read orders and order_settlements as one consistent set of facts. On the job's transaction
// (default READ COMMITTED, other statements before it), order-sync may commit between two reads:
// here a second connection commits right after the first statement readSource runs — X goes
// ESTIMATED → WAITING with settle_period and its first settlement row, and a new order Y arrives with
// its settlement, in one transaction. The rows returned must be either all before that commit or
// all after it; a mix (X still ESTIMATED but with a settlement → a false union_mismatch; Y's
// settlement without its order → a false 「我方无单」) is the bug. Single-statement read or one
// snapshot: the test does not care how.
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { sql, type KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import {
  createBillSourceReader,
  type BillSourceRow,
} from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import {
  APP,
  BILL_DAY_NOW,
  BILL_DAY_START,
  BILL_MONTH,
  TAOBAO,
  TIMEOUT,
  insertOrderRow,
  seedKey,
  seedOrder,
  seedSettlement,
  withDatabase,
} from './kit.ts';

interface View {
  readonly key: string;
  readonly status: string | null;
  readonly settlePeriod: string | null;
  readonly seqs: number[];
}

function view(rows: readonly BillSourceRow[]): View[] {
  return rows.map((row) => ({
    key: row.orderKey,
    status: row.order === null ? null : row.order.rebateStatus,
    settlePeriod: row.order === null ? null : row.order.settlePeriod,
    seqs: row.settlements.map((s) => s.seq),
  }));
}

function sortedByKey(views: View[]): View[] {
  return [...views].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Runs `hook` once, right after the first statement executed while armed returns its result. */
function afterFirstStatement(hook: () => Promise<void>) {
  const state = { armed: false, fired: false };
  const plugin: KyselyPlugin = {
    transformQuery: (args) => args.node,
    async transformResult(args) {
      if (state.armed && !state.fired) {
        state.fired = true;
        await hook();
      }
      return args.result;
    },
  };
  return { plugin, state };
}

it(
  '[AC-B2-04ze#29] readSource 的订单与结算记录来自同一时点：两次读之间另一连接提交（X 进 WAITING 并到结算、新单 Y 连同结算到达），返回结果要么全是提交前、要么全是提交后，不混读',
  async () => {
    await withDatabase(createTestDatabase, async (db, observer) => {
      const x = await seedOrder(db, APP, TAOBAO, { rebateStatus: 'ESTIMATED', settlePeriod: null });
      const yId = randomUUID();
      const yKey = `${TAOBAO}:synthetic-${yId}`;

      // order-sync's commit on another connection (one transaction).
      const commit = () =>
        observer.transaction().execute(async (trx) => {
          await trx
            .withSchema('app')
            .updateTable('orders')
            .set({ rebate_status: 'WAITING', settle_period: BILL_MONTH })
            .where('app_id', '=', APP)
            .where('order_id', '=', x.orderId)
            .execute();
          await seedSettlement(trx, x);
          const y = await seedKey(trx, APP, TAOBAO, yId);
          await insertOrderRow(trx, y);
          await seedSettlement(trx, y);
        });

      const { plugin, state } = afterFirstStatement(commit);
      const reader = createBillSourceReader({
        readUnionAuthoritative: async () => new Set<string>(),
      });
      const rows = await db
        .withPlugin(plugin)
        .transaction()
        .execute(async (trx) => {
          // The bill job has run statements on its transaction before readSource (claim, bill row).
          await sql`SELECT 1`.execute(trx);
          state.armed = true;
          return reader(trx, {
            appId: APP,
            platform: TAOBAO,
            runAt: new Date(BILL_DAY_START),
            billId: BILL_MONTH,
            generationStartedAt: new Date(BILL_DAY_NOW),
          });
        });
      expect(state.fired, 'the concurrent commit did not run during readSource').toBe(true);

      const before: View[] = [{ key: x.key, status: 'ESTIMATED', settlePeriod: null, seqs: [] }];
      const after: View[] = sortedByKey([
        { key: x.key, status: 'WAITING', settlePeriod: BILL_MONTH, seqs: [1] },
        { key: yKey, status: 'WAITING', settlePeriod: BILL_MONTH, seqs: [1] },
      ]);
      expect([before, after]).toContainEqual(view(rows));
    });
  },
  TIMEOUT,
);
