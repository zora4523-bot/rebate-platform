// B1-09n · 生产同步主线：真实 worker 入口的流水线、真实 PostgreSQL，端口不自注入（kit.ts）。
// 接线之前生产订单停在 UNATTRIBUTED，预估、入账、作废都没有起点；这里钉 R1 / R2 / R3a / R4 / R6 / R7。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at } from '../wiring/db-kit.ts';
import {
  ATTR_CODE,
  JD_INVALID,
  JD_RECEIVED,
  RELATION,
  TIMEOUT,
  UNKNOWN_CODE,
  withFixture,
} from './kit.ts';

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

const RECEIVED_AT = at('2026-10-21T02:00:00.000Z');

it(
  '[AC-B1-09n#5] 同步进来的已归因订单：ESTIMATED，快照 v1，orders.commission_version=1',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({
        user_id: f.userId,
        platform_status: 'PAID',
        rebate_status: 'ESTIMATED',
        commission_version: 1,
      });
      expect(await f.splits()).toHaveLength(1);
      const amounts = await f.amounts();
      expect(amounts.map((row) => [row.commission_version, row.amount_fen])).toEqual([[1, 500n]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#6] 佣金变化：版本 2，有 v2 金额与 totals，v1 不动，返利状态不变（R7）',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', commission_version: 1 });
      await f.sync(f.touch(1, { est_commission_fen: 800n, commission_fen: 800n }));
      expect(await f.row()).toMatchObject({
        rebate_status: 'ESTIMATED',
        est_commission_fen: 800n,
        commission_version: 2,
      });
      const amounts = await f.amounts();
      expect(amounts.map((row) => [row.commission_version, row.base_fen, row.amount_fen])).toEqual([
        [1, 1000n, 500n],
        [2, 800n, 400n],
      ]);
      const totals = await f.totals();
      expect(totals.map((row) => [row.commission_version, row.base_fen])).toEqual([
        [1, 1000n],
        [2, 800n],
      ]);
      expect(await f.splits()).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#7] 未归因订单留在 UNATTRIBUTED，无快照；后续归因走到 ESTIMATED，快照 v1（R1、R3a）',
  async () => {
    await withFixture(
      db,
      async (f) => {
        await f.sync();
        expect(await f.row()).toMatchObject({
          user_id: null,
          rebate_status: 'UNATTRIBUTED',
          commission_version: 0,
        });
        expect(await f.splits()).toEqual([]);
        await f.sync(
          f.touch(1, {
            attr_params: {
              relation_id: RELATION,
              sub_union_id: `n_${ATTR_CODE}`,
              custom_parameters: null,
            },
          }),
        );
        expect(await f.row()).toMatchObject({
          user_id: f.userId,
          user_basis: 'param',
          rebate_status: 'ESTIMATED',
          commission_version: 1,
        });
        expect((await f.amounts()).map((row) => row.amount_fen)).toEqual([500n]);
      },
      {
        patch: {
          attr_params: {
            relation_id: RELATION,
            sub_union_id: `n_${UNKNOWN_CODE}`,
            custom_parameters: null,
          },
        },
      },
    );
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#8] 收货走到 WAITING：settle_period 取收货时间的月份，received_synced_at 取 Clock（R4）',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED' });
      await f.sync(f.touch(1, { raw_status: JD_RECEIVED, received_at: RECEIVED_AT }));
      expect(await f.row()).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'WAITING',
        settle_period: '2026-10',
        received_synced_at: f.clock.now(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#9] 入库时已收货：同一事务 R2 再 R4，直接 WAITING',
  async () => {
    await withFixture(
      db,
      async (f) => {
        await f.sync();
        expect(await f.row()).toMatchObject({
          platform_status: 'RECEIVED',
          rebate_status: 'WAITING',
          settle_period: '2026-10',
          commission_version: 1,
        });
      },
      { patch: { raw_status: JD_RECEIVED, received_at: RECEIVED_AT } },
    );
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#10] 平台失效走 VOID：reason=REFUND，同事务发 order.invalidated（R6）',
  async () => {
    await withFixture(db, async (f) => {
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED' });
      await f.sync(f.touch(1, { raw_status: JD_INVALID }));
      expect(await f.row()).toMatchObject({
        platform_status: 'INVALID',
        rebate_status: 'VOID',
        reason: 'REFUND',
      });
      expect(await f.eventNames()).toContain('order.invalidated');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-09n#11] 端口的 config 读 config_items：settle.period_basis 配了不认的取值，订单留在 ESTIMATED',
  async () => {
    await withFixture(db, async (f) => {
      await f.setConfig('settle.period_basis.jd', 'settled_at');
      await f.sync();
      expect(await f.row()).toMatchObject({ rebate_status: 'ESTIMATED', commission_version: 1 });
      await f.sync(f.touch(1, { raw_status: JD_RECEIVED, received_at: RECEIVED_AT }));
      expect(await f.row()).toMatchObject({
        platform_status: 'RECEIVED',
        rebate_status: 'ESTIMATED',
        settle_period: null,
      });
    });
  },
  TIMEOUT,
);
