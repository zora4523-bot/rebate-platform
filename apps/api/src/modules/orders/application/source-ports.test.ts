// B1-08q 源码旁单元测试：来源回填端口的生产实现（配置解析、商品键、读口转发）与 backfillOrderSource 在注入
// sourceConfig 时的取值路径（D10-76）。不连库：别的模块的原始读口全用桩。
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { LinkLogCandidate } from '../domain/source-backfill.ts';
import { backfillOrderSource, type OrderSourcePorts } from './source-backfill.ts';
import {
  BACKFILL_WINDOW_HOURS_KEY,
  backfillWindowHoursOf,
  clickCodeEnabledOf,
  clickCodeKey,
  createOrderSourcePorts,
  type OrderSourceReads,
} from './source-ports.ts';

const at = (iso: string) => new FixedClock(iso).now();
const ATTR = '2026-10-20T04:00:00.000Z';

function order(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: 'unit-parent',
    promotion_slot: 'slot-unit',
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
    },
    raw_status: 'paid',
    goods_id: '123',
    paid_fen: 100n,
    commission_fen: 10n,
    est_commission_fen: 10n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at(ATTR),
    received_at: null,
    settled_at: null,
    modified_at: at(ATTR),
    raw_payload_id: '1',
    ...patch,
  };
}

function log(patch: Partial<LinkLogCandidate> = {}): LinkLogCandidate {
  return {
    id: 1n,
    link_id: '00000000-0000-4000-8000-000000000001',
    user_id: 'user-U',
    platform: 'pdd',
    product_key: 'pdd:123',
    shop_id: null,
    event: 'open',
    result_code: 0,
    pid_scene: 'share',
    scene: 'search',
    agent_session_id: null,
    created_at: at('2026-10-19T04:00:00.000Z'),
    ...patch,
  };
}

function reads(config: Record<string, unknown> = {}, prefixes: Record<string, string | null> = {}) {
  const linkLogs = vi.fn<OrderSourceReads['linkLogs']>().mockResolvedValue([log()]);
  const keyPrefix = vi.fn<OrderSourceReads['keyPrefix']>(async (platform) =>
    platform in prefixes ? (prefixes[platform] ?? null) : null,
  );
  const configValue = vi.fn<OrderSourceReads['configValue']>(async (_app, key) =>
    key in config ? { value: config[key] } : null,
  );
  return { linkLogs, keyPrefix, configValue };
}

it('[AC-B1-08q#u1] 开关只认 JSON true；窗口只认正的安全整数，其余回 360', () => {
  expect(clickCodeEnabledOf(true)).toBe(true);
  for (const value of ['true', 1, null, undefined, false, {}, []]) {
    expect(clickCodeEnabledOf(value)).toBe(false);
  }
  expect(backfillWindowHoursOf(480)).toBe(480);
  expect(backfillWindowHoursOf(1)).toBe(1);
  for (const value of ['480', 0, -1, 1.5, null, undefined, true, Number.MAX_SAFE_INTEGER + 1]) {
    expect(backfillWindowHoursOf(value)).toBe(360);
  }
  expect(clickCodeKey('jd')).toBe('attr.click_code.jd');
  expect(BACKFILL_WINDOW_HOURS_KEY).toBe('attr.backfill_window_hours');
});

it('[AC-B1-08q#u2] sourceConfig 按 App 与平台读两个键，每次调用都重读，缺省 false/360', async () => {
  const r = reads({ 'attr.click_code.pdd': true, 'attr.backfill_window_hours': 24 });
  const ports = createOrderSourcePorts(r);
  expect(r.configValue).not.toHaveBeenCalled();
  expect(await ports.sourceConfig('app-1', 'pdd')).toEqual({
    clickCodeEnabled: true,
    backfillWindowHours: 24,
  });
  expect(await ports.sourceConfig('app-1', 'jd')).toEqual({
    clickCodeEnabled: false,
    backfillWindowHours: 24,
  });
  expect(r.configValue.mock.calls).toEqual([
    ['app-1', 'attr.click_code.pdd'],
    ['app-1', 'attr.backfill_window_hours'],
    ['app-1', 'attr.click_code.jd'],
    ['app-1', 'attr.backfill_window_hours'],
  ]);
  const empty = createOrderSourcePorts(reads());
  expect(await empty.sourceConfig('app-2', 'pdd')).toEqual({
    clickCodeEnabled: false,
    backfillWindowHours: 360,
  });
});

it('[AC-B1-08q#u3] 配置与前缀读取失败原样抛出，不转成缺省值或 null', async () => {
  const failure = new Error('unit read failure');
  const r = reads();
  r.configValue.mockRejectedValue(failure);
  r.keyPrefix.mockRejectedValue(failure);
  const ports = createOrderSourcePorts(r);
  await expect(ports.sourceConfig('app-1', 'pdd')).rejects.toBe(failure);
  await expect(ports.productKey({ platform: 'pdd', order: order() })).rejects.toBe(failure);
});

it('[AC-B1-08q#u4] productKey 每次读前缀：有前缀推出键，无行/空前缀/推不出 → null，京东不读不猜', async () => {
  const prefixes: Record<string, string | null> = { pdd: 'pdd', taobao: 'tb' };
  const r = reads({}, prefixes);
  const ports = createOrderSourcePorts(r);
  expect(await ports.productKey({ platform: 'pdd', order: order() })).toBe('pdd:123');
  expect(
    await ports.productKey({
      platform: 'taobao',
      order: order({ platform: 'taobao', item_id: 'abc-456' }),
    }),
  ).toBe('tb:456');
  expect(await ports.productKey({ platform: 'pdd', order: order({ goods_id: '' }) })).toBeNull();
  prefixes.pdd = 'px';
  expect(await ports.productKey({ platform: 'pdd', order: order() })).toBe('px:123');
  prefixes.pdd = null;
  expect(await ports.productKey({ platform: 'pdd', order: order() })).toBeNull();
  delete prefixes.pdd;
  expect(await ports.productKey({ platform: 'pdd', order: order() })).toBeNull();
  const reads0 = r.keyPrefix.mock.calls.length;
  const jd = order({ platform: 'jd', itemId: 'x_123', skuId: '456' });
  expect(await ports.productKey({ platform: 'jd', order: jd })).toBeNull();
  expect(r.keyPrefix.mock.calls.length).toBe(reads0);
  expect(r.keyPrefix.mock.calls.every(([platform]) => platform !== 'jd')).toBe(true);
});

it('[AC-B1-08q#u5] linkLogs 原样转发；短码反查不注入', async () => {
  const r = reads();
  const ports = createOrderSourcePorts(r);
  const input = {
    appId: 'app-1',
    userId: 'user-U',
    platform: 'pdd' as const,
    from: at('2026-10-05T04:00:00.000Z'),
    to: at(ATTR),
  };
  expect(await ports.linkLogs(input)).toEqual([log()]);
  expect(r.linkLogs).toHaveBeenCalledExactlyOnceWith(input);
  expect(ports.linkByCode).toBeUndefined();
});

it('[AC-B1-08q#u6] 注入 sourceConfig：按 App 读一次，窗口取它的值，不再调旧的两个口子', async () => {
  const row = log({ created_at: at('2026-10-01T04:00:00.000Z') });
  const linkLogs = vi.fn<OrderSourcePorts['linkLogs']>().mockResolvedValue([row]);
  const productKey = vi.fn<OrderSourcePorts['productKey']>().mockResolvedValue('pdd:123');
  const clickCode = vi.fn(() => true);
  const windowHours = vi.fn(() => 1);
  const sourceConfig = vi.fn(async () => ({ clickCodeEnabled: false, backfillWindowHours: 480 }));
  const linkByCode = vi.fn<NonNullable<OrderSourcePorts['linkByCode']>>().mockResolvedValue(null);
  const result = await backfillOrderSource(
    { linkLogs, productKey, clickCode, windowHours, sourceConfig, linkByCode },
    {
      appId: 'app-9',
      platform: 'pdd',
      userId: 'user-U',
      attrAt: at(ATTR),
      pidScene: 'share',
      shopId: null,
      order: order(),
    },
  );
  expect(result).toEqual({
    source_match: 'product',
    link_id: row.link_id,
    source_scene: row.scene,
    agent_session_id: null,
  });
  expect(sourceConfig).toHaveBeenCalledExactlyOnceWith('app-9', 'pdd');
  expect(clickCode).not.toHaveBeenCalled();
  expect(windowHours).not.toHaveBeenCalled();
  expect(linkByCode).not.toHaveBeenCalled();
  expect(linkLogs).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ from: at('2026-09-30T04:00:00.000Z'), to: at(ATTR) }),
  );
});

it('[AC-B1-08q#u7] 未注入 sourceConfig：照旧用 clickCode / windowHours（同步无参写法照常可用）', async () => {
  const linkLogs = vi.fn<OrderSourcePorts['linkLogs']>().mockResolvedValue([]);
  const productKey = vi.fn<OrderSourcePorts['productKey']>().mockResolvedValue('pdd:123');
  const linkByCode = vi.fn<NonNullable<OrderSourcePorts['linkByCode']>>().mockResolvedValue(null);
  const result = await backfillOrderSource(
    { linkLogs, productKey, linkByCode, clickCode: () => true, windowHours: () => 24 },
    {
      appId: 'app-9',
      platform: 'pdd',
      userId: 'user-U',
      attrAt: at(ATTR),
      pidScene: 'share',
      shopId: null,
      order: order(),
    },
  );
  expect(result.source_match).toBe('none');
  expect(linkByCode).toHaveBeenCalledExactlyOnceWith({
    appId: 'app-9',
    platform: 'pdd',
    lk: 'a1b2c3',
  });
  expect(linkLogs).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ from: at('2026-10-19T04:00:00.000Z') }),
  );
});
