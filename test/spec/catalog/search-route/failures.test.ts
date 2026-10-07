import { afterEach, expect, it, vi } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { candidate, claims, fixture, observed } from '../search/kit.ts';

afterEach(() => vi.restoreAllMocks());

/** Accept flat error fields or pino's Error serializer; require the actual diagnostic text. */
function warnings(f: ReturnType<typeof fixture>): string {
  return JSON.stringify(f.warn.mock.calls, (_key, value: unknown) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
}

it.each([
  new TypeError('synthetic adapter programming defect'),
  Object.assign(new Error('synthetic exhausted connection reset'), { code: 'ECONNRESET' }),
  Object.assign(new Error('synthetic exhausted connection refused'), { code: 'ECONNREFUSED' }),
  new platform.GovernanceError('timeout', 'union.search', 'synthetic exhausted deadline'),
])('[AC-B1-05j#10] 搜索故障 %s 保留原始 cause，并将错误信息送到告警端口', async (failure) => {
  const f = fixture();
  f.search.mockRejectedValue(failure);
  const result = await observed(() => f.run());
  expect(result).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
  if (result.kind !== 'rejected') return;
  expect(result.error).toHaveProperty('data', { platform: 'taobao' });
  expect(result.error).toHaveProperty('cause', failure);
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'taobao' }),
    expect.any(String),
  );
  expect(warnings(f)).toContain(failure.message);
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-05j#11] 首页面全被过滤且补拉故障：50304/cause，不得返回空成功或物料', async () => {
  const f = fixture();
  const failure = new Error('synthetic refill transport exhausted');
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  f.search
    .mockResolvedValueOnce({ items: [candidate('zero')], hasMore: true })
    .mockRejectedValueOnce(failure);
  const result = await observed(() => f.run());
  expect(result).toMatchObject({ kind: 'rejected', error: { code: 50304 } });
  if (result.kind !== 'rejected') return;
  expect(result.error).toHaveProperty('data', { platform: 'taobao' });
  expect(result.error).toHaveProperty('cause', failure);
  expect(warnings(f)).toContain(failure.message);
  expect(f.search.mock.calls.map(([request]) => request.pageNo)).toEqual([1, 2]);
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-05j#12] 首页面仍有卡且补拉故障：保留第一页、重试故障页、告警带诊断', async () => {
  const f = fixture();
  const failure = new Error('synthetic refill circuit failure');
  f.search
    .mockResolvedValueOnce({ items: [candidate('kept')], hasMore: true })
    .mockRejectedValueOnce(failure);
  const result = await observed(() => f.run());
  expect(result).toMatchObject({ kind: 'returned', value: { has_more: true, fallback_items: [] } });
  if (result.kind !== 'returned') return;
  expect(result.value.items.map((card) => card.title)).toEqual(['synthetic-kept']);
  expect(claims(f, result.value.next_cursor)).toMatchObject({ page_no: 2 });
  expect(f.search.mock.calls.map(([request]) => request.pageNo)).toEqual([1, 2]);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.materialFeed).not.toHaveBeenCalled();
  expect(warnings(f)).toContain(failure.message);
});

it.each([
  new UnionError('upstream_rejected', 'synthetic material business rejection', 'taobao'),
  new UnionError('item_unavailable', 'synthetic material item unavailable', 'taobao'),
  new platform.GovernanceError(
    'invalid_policy',
    'union.materialFeed',
    'synthetic material invalid policy',
  ),
  new CatalogError(30131, 'synthetic material unsupported'),
])('[AC-B1-05j#13] 物料兜底业务拒绝 %s 返回空 fallback_items 并告警', async (failure) => {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'synthetic-feed',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = fixture();
  f.materialFeed.mockRejectedValue(failure);
  const result = await observed(() => f.run());
  expect(result).toEqual({
    kind: 'returned',
    value: { items: [], has_more: false, next_cursor: null, fallback_items: [] },
  });
  expect(f.materialFeed).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    channelId: 'synthetic-feed',
    limit: 10,
    promotionSlot: 'synthetic-query-pid',
  });
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'taobao' }),
    expect.any(String),
  );
  expect(warnings(f)).toContain(failure.message);
  expect(f.register).not.toHaveBeenCalled();
});
