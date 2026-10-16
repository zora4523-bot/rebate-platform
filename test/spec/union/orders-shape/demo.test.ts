import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { outcome } from '../archive/kit.ts';
import { demo, platforms } from '../demo/kit.ts';
import { ctx, win } from '../pdd-orders/kit.ts';
import { value } from './kit.ts';

async function firstPage(adapter: UnionAdapter) {
  // 业务拒绝先转成值，使旧演示端口以断言失败先红；编程错误仍由 outcome 抛出。
  const result = await outcome(() => adapter.listOrders(win, {}, ctx));
  expect(result).not.toBeInstanceOf(Error);
  expect(result).toMatchObject({ items: expect.any(Array) });
  const page = result as Awaited<ReturnType<UnionAdapter['listOrders']>>;
  expect(page.items.length).toBeGreaterThan(0);
  return page;
}

it.each(platforms)(
  '[AC-B1-08e-DEMO#1] %s 演示订单具备统一字段、合成状态与空归档编号',
  async (platform) => {
    const page = await firstPage(demo(platform, 'orders-shape-a', new FixedClock(win.to)));
    for (const order of page.items) {
      expect(order).toMatchObject({
        platform,
        sub_order_id: expect.any(String),
        attr_params: {
          relation_id: expect.toSatisfy(
            (input: unknown) => input === null || typeof input === 'string',
          ),
          custom_parameters: expect.toSatisfy(
            (input: unknown) => input === null || typeof input === 'string',
          ),
          sub_union_id: expect.toSatisfy(
            (input: unknown) => input === null || typeof input === 'string',
          ),
        },
        raw_status: expect.any(String),
        raw_payload_id: null,
      });
      expect(value(order, 'sub_order_id')).toMatch(/^demo-\S+/);
      expect(value(order, 'raw_status')).toMatch(/\S/);
      for (const field of ['parent_order_id', 'promotion_slot']) {
        const actual = value(order, field);
        expect(actual === null || typeof actual === 'string', field).toBe(true);
      }
      for (const field of [
        'deposit_paid_at',
        'paid_at',
        'received_at',
        'settled_at',
        'modified_at',
      ]) {
        const actual = value(order, field);
        expect(actual === null || actual instanceof Date, field).toBe(true);
        if (actual instanceof Date) expect(Number.isFinite(actual.getTime()), field).toBe(true);
      }
      for (const field of ['est_commission_fen', 'settle_commission_fen']) {
        const actual = value(order, field);
        expect(actual === null || typeof actual === 'bigint', field).toBe(true);
      }
      expect(order.paid_fen).toBeTypeOf('bigint');
      expect(order.commission_fen).toBeTypeOf('bigint');
    }
  },
);

it.each(platforms)(
  '[AC-B1-08e-DEMO#2] %s 同种子同窗口跨实例与重复调用均确定，换种子改变子单号',
  async (platform) => {
    const adapter = demo(platform, 'orders-shape-a', new FixedClock(win.to));
    const first = await firstPage(adapter);
    expect(await firstPage(adapter)).toEqual(first);
    expect(await firstPage(demo(platform, 'orders-shape-a', new FixedClock(win.to)))).toEqual(
      first,
    );
    const changed = await firstPage(demo(platform, 'orders-shape-b', new FixedClock(win.to)));
    const ids = first.items.map((order) => value(order, 'sub_order_id'));
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(changed.items.map((order) => value(order, 'sub_order_id'))).not.toEqual(ids);
  },
);
