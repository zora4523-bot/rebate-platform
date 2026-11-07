// B1-08zi（D10-814 ① ② ③）：件数与已退件数经生产 worker 的订单流水线写进 orders：首次入库（pipeline-port）与
// 后续同步（update-step）都写、与同步 upsert 同一事务；缺失沿用库内值、只增不减（变小不写，打一条带 alert 字段
// 的告警日志，不带子订单号）；只有数量变化时 commission_version 不动；refunded_quantity_at_credit 不由同步写。
// 路径与 ../../settlement/settle-diff-sync/kit.ts 相同：报文是归一后的 UnionOrder，平台是 pdd（那套 kit 只有
// pdd 的状态表带结算码）。拼多多适配器本身不给这两个字段，这里的值是合成的：orders 只读归一后的 DTO、不按平台
// 分支（orders/AGENTS.md 硬规则 1），京东的字段来源由 jd-mapping.test.ts 钉住。
// Task-local AC labels ([AC-B1-08zi#n]) identify this task's acceptance points, not business rules.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  touched,
  withSync,
} from '../../settlement/settle-diff-sync/kit.ts';

const p = databaseFixture(createTestDatabase);

/** The alert lines that name `reason` for the app (any field value), from the captured pino lines. */
function alertsNaming(logs: readonly Record<string, unknown>[], appId: string, reason: string) {
  return logs.filter(
    (line) =>
      typeof line.alert === 'string' &&
      line.app_id === appId &&
      Object.values(line).includes(reason),
  );
}

it(
  '[AC-B1-08zi#15] 首次入库写报文给的 quantity / refunded_quantity；报文不给的订单两列为空；at_credit 都为空',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      const given = w.order(app, { quantity: 3, refunded_quantity: 1 });
      const absent = w.order(app);
      await given.sync();
      await absent.sync();
      expect(await given.row()).toMatchObject({
        quantity: 3,
        refunded_quantity: 1,
        refunded_quantity_at_credit: null,
      });
      expect(await absent.row()).toMatchObject({
        quantity: null,
        refunded_quantity: null,
        refunded_quantity_at_credit: null,
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#16] 后续同步：增加写入；没给沿用；变小不写并告警；commission_version 与返利状态都不动',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 3, refunded_quantity: 0 });
      await o.sync();
      const first = await o.row();
      expect(first).toMatchObject({ quantity: 3, refunded_quantity: 0 });

      await o.sync({ ...touched(1), refunded_quantity: 2 });
      expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 2 });

      await o.sync({ ...touched(2), quantity: null, refunded_quantity: null });
      expect(await o.row()).toMatchObject({ quantity: 3, refunded_quantity: 2 });
      expect(alertsNaming(logs, app.appId, 'refunded_quantity_decreased')).toEqual([]);

      await o.sync({ ...touched(3), quantity: 3, refunded_quantity: 1 });
      const last = await o.row();
      expect(last).toMatchObject({
        quantity: 3,
        refunded_quantity: 2,
        refunded_quantity_at_credit: null,
        commission_version: first.commission_version,
        rebate_status: first.rebate_status,
        est_commission_fen: first.est_commission_fen,
      });
      // 告警只在拒写的那次同步出现；本次报文的其余列照写（platform_modified_at 前进）。
      const alerts = alertsNaming(logs, app.appId, 'refunded_quantity_decreased');
      expect(alerts).toHaveLength(1);
      expect(Object.values(alerts[0]!)).not.toContain(o.subOrderId);
      expect(last.platform_modified_at?.toISOString()).toBe('2026-10-21T10:03:00.000Z');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#17] 件数变小同样不写并告警；已退件数同一次增加照写',
  async () => {
    await withSync(p.db, async (w, logs) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 4, refunded_quantity: 1 });
      await o.sync();
      await o.sync({ ...touched(1), quantity: 2, refunded_quantity: 2 });
      expect(await o.row()).toMatchObject({ quantity: 4, refunded_quantity: 2 });
      expect(alertsNaming(logs, app.appId, 'quantity_decreased')).toHaveLength(1);
      expect(alertsNaming(logs, app.appId, 'refunded_quantity_decreased')).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-08zi#18] 首次入库已退件数大于 0 也原样写；同一报文重放不改两列',
  async () => {
    await withSync(p.db, async (w) => {
      const app = await w.app();
      const o = w.order(app, { quantity: 5, refunded_quantity: 2 });
      await o.sync();
      const row = await o.row();
      expect([row.quantity, row.refunded_quantity, row.refunded_quantity_at_credit]).toEqual([
        5,
        2,
        null,
      ]);
      await o.sync();
      expect(await o.row()).toMatchObject({ quantity: 5, refunded_quantity: 2 });
    });
  },
  TIMEOUT,
);
