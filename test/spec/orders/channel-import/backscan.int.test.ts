// 不回扫存量订单（08 BR-ATTR-26「检查时点」「为什么不做全表回扫」）：渠道单导入只新增名单条目；导入前已入库
// 的订单——即使其 relation_id、联盟账号与 attr_at 都落在新条目的生效区间里——导入后订单、状态历史与风控
// 命中都不变，名单让订单失效只在之后的流水线运行时（B1-09b）。订单用 B1-09b 的夹具（淘宝、relation_id 由
// 补丁指定）经不带黑名单步骤的流水线首次入库。用例全部是顶层 it（规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createChannelImportProcessor } from '../../../../apps/api/src/modules/orders/application/channel-import.ts';
import type { RightsImportTaskInfo } from '../../../../apps/api/src/modules/orders/application/rights-import-ports.ts';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import { ATTR_AT, setup as orderSetup } from '../blacklist/kit.ts';
import { RELATION, channelDeps, entriesOf, plusMs, rowOf } from './db-kit.ts';

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

const HOUR_MS = 3_600_000;

it.each(['UNATTRIBUTED', 'ESTIMATED', 'CREDITED'])(
  '[AC-B1-09h#6] 不回扫：导入前已入库（%s）、落在新条目生效区间内的订单，导入后订单与风控命中都不变',
  async (rebateStatus) => {
    const f = await orderSetup(db, {
      attr_params: { relation_id: RELATION, sub_union_id: null, custom_parameters: null },
    });
    const imported = await createOrderPipeline(f.plainDeps).process(f.incoming, f.ctx);
    expect(imported.kind).toBe('inserted');
    await db
      .updateTable('orders')
      .set({ rebate_status: rebateStatus })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    const before = await f.read();
    expect(before.orders).toHaveLength(1);
    expect(before.orders[0]).toMatchObject({ rebate_status: rebateStatus });

    // 受理时刻早于订单的 attr_at 一小时、end_at 为空：若回扫，这笔订单正落在新条目的生效区间里。
    const createdAt = plusMs(ATTR_AT.toISOString(), -HOUR_MS);
    const task: RightsImportTaskInfo = {
      import_id: randomUUID(),
      app_id: f.ctx.app_id,
      kind: 'channel',
      platform: 'taobao',
      union_account_id: f.ctx.union_account_id,
      time_basis: null,
      from: null,
      to: null,
      created_by: randomUUID(),
      created_at: createdAt,
    };
    const { deps } = channelDeps(db, f.clock);
    const processor = createChannelImportProcessor(deps);
    expect(await processor.process(task, rowOf(RELATION))).toEqual({ kind: 'succeeded' });

    const entries = await entriesOf(db, f.ctx.app_id);
    expect(entries.map((e) => [e.value, e.union_account_id, e.start_at, e.end_at])).toEqual([
      [RELATION, f.ctx.union_account_id, createdAt, null],
    ]);
    expect(await f.read()).toEqual(before);
  },
);
