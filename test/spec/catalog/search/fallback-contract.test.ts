import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { candidate, fixture } from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05d#35] 真实白名单为空时搜索无结果返回空 fallback_items，不能随便选物料频道', async () => {
  const f = fixture();
  const result = await f.run();
  expect(platform.getMaterialChannels().channels).toEqual([]);
  expect(result).toEqual({ items: [], next_cursor: null, has_more: false, fallback_items: [] });
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it('[AC-B1-05d#36] 仅使用本平台可选白名单频道，返回物料流前 10 个且不套搜索价格筛选', async () => {
  // Synthetic channel metadata, not a claimed real platform channel or upstream recording.
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'jd',
        channel_id: 'synthetic-foreign',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
      {
        platform: 'taobao',
        channel_id: 'synthetic-forbidden',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: false,
        source: 'synthetic',
      },
      {
        platform: 'taobao',
        channel_id: 'synthetic-allowed',
        name: 'synthetic',
        sort_basis: 'popularity',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = fixture();
  f.materialFeed.mockResolvedValue({
    items: Array.from({ length: 12 }, (_, index) => candidate(`feed-${index}`, 5000n)),
    hasMore: true,
  });
  const result = await f.run({ price_max_fen: 1, has_coupon: true, sort: 'rebate_desc' });
  expect(result.items).toEqual([]);
  expect(result.fallback_items.map((card) => card.title)).toEqual(
    Array.from({ length: 10 }, (_, index) => `synthetic-feed-${index}`),
  );
  expect(f.materialFeed).toHaveBeenCalledExactlyOnceWith({
    appId: 'synthetic-app',
    platform: 'taobao',
    channelId: 'synthetic-allowed',
    limit: 10,
    promotionSlot: 'synthetic-query-pid',
  });
  expect(result).toMatchObject({ next_cursor: null, has_more: false });
});

it('[AC-B1-05d#37] fallback 也过滤无返利和异常价，通过统一出卡入口', async () => {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'synthetic-allowed',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = fixture();
  const anomaly = candidate('anomaly');
  f.materialFeed.mockResolvedValue({
    items: [
      candidate('zero'),
      {
        ...anomaly,
        item: {
          ...anomaly.item,
          price_status: 'anomaly',
          price_fen: 0n,
          coupon_fen: 0n,
          final_price_fen: 0n,
        },
      },
      candidate('good'),
    ],
    hasMore: false,
  });
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  const result = await f.run();
  expect(result.fallback_items.map((card) => card.title)).toEqual(['synthetic-good']);
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'PRICE_ANOMALY' }),
    expect.any(String),
  );
  expect(f.register.mock.calls.some(([input]) => input.item.title === 'synthetic-anomaly')).toBe(
    false,
  );
  expect(f.assemble).toHaveBeenCalledWith(
    expect.objectContaining({ scene: 'retrieval', entrySource: 'search' }),
  );
});

it('[AC-B1-05d#38] 非首页空结果及正常非空结果都不提供物料推荐', async () => {
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'synthetic-allowed',
        name: 'synthetic',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
    ],
  });
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: true });
  f.pages.set(2, { items: [], hasMore: false });
  const first = await f.run({ limit: 1 });
  expect(first.fallback_items).toEqual([]);
  const next = await f.run({ limit: 1, cursor: first.next_cursor! });
  expect(next).toMatchObject({ items: [], fallback_items: [], has_more: false });
  expect(f.materialFeed).not.toHaveBeenCalled();
});

it('[AC-B1-05d#39] 搜索响应 data 与真实 SearchProductsData 契约一致', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a')], hasMore: false });
  const result = await f.run();
  const root = new URL('../../../../', import.meta.url);
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const contract = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schema = contract.components.schemas['SearchProductsData'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(JSON.parse(JSON.stringify(result))), JSON.stringify(validate.errors)).toBe(true);
  expect(result.items).toHaveLength(1);
});
