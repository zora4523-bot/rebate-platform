// B1-28h: GET /v1/rank/hot over the real app (x-auth none, security []); envelope mapping of the
// use case's 20001 (data.fields) and 50304 (data.platform, reason rank_unavailable or none), and the
// real wiring reading specs/material-channels.yaml.
import { afterEach, expect, it, vi } from 'vitest';
import { rankPlatforms } from '../../../../apps/api/src/modules/content/domain/config-etag.ts';
import type { HotRankData } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import {
  FixedClock,
  getMaterialChannels,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError, type Platform } from '../../../../apps/api/src/modules/union/index.ts';
import type { HttpApp, Response } from '../search-route/http-kit.ts';
import { NOW, PAGE_SIZE, TB_CHANNEL, assertSchema, candidate, channel, series } from './kit.ts';
import { hotRankRequest, httpFixture, startApp } from './http-kit.ts';

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

interface Envelope {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
  trace_id: string;
}

async function expectError(
  response: Response,
  status: number,
  code: number,
  data: Record<string, unknown>,
): Promise<Envelope> {
  expect(response.statusCode).toBe(status);
  await assertSchema(response.json(), 'ErrorEnvelope');
  const body = response.json<Envelope>();
  expect(body.code).toBe(code);
  expect(body.data).toMatchObject(data);
  return body;
}

it('[AC-B1-28h#24] 真实装配按 specs/material-channels.yaml 判定：没有合规频道的平台 → 503/50304 data.reason=rank_unavailable；游客可访问、路由存在', async () => {
  app = await startApp(new FixedClock(NOW));
  const listed = rankPlatforms(getMaterialChannels());
  const platforms: readonly Platform[] = ['taobao', 'jd', 'pdd'];
  for (const platform of platforms) {
    const response = await hotRankRequest(app, { platform });
    expect(response.statusCode, platform).not.toBe(404);
    expect(response.statusCode, platform).not.toBe(401);
    if (!listed.includes(platform)) {
      await expectError(response, 503, 50304, { platform, reason: 'rank_unavailable' });
    }
  }
});

it('[AC-B1-28h#25] 游客 GET /v1/rank/hot 得到契约 HotRankResponse：频道顺序的名次、原样的 sales_text、notice_key；查询参数原样交给用例', async () => {
  const f = await httpFixture();
  app = f.app;
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.setPage('taobao', TB_CHANNEL, 'synthetic-digital', 1, [
    candidate('http-a', { salesText: '10万+' }),
    candidate('http-b'),
  ]);

  const response = await f.request({ category: 'synthetic-digital' });

  expect(response.statusCode).toBe(200);
  await assertSchema(response.json(), 'HotRankResponse');
  const body = response.json<{ code: number; trace_id: string; data: HotRankData }>();
  expect(body.code).toBe(0);
  expect(body.trace_id).toBe(response.headers['x-trace-id']);
  expect(body.data).toMatchObject({
    channel: TB_CHANNEL,
    categories: [{ category_id: 'synthetic-digital', name: '合成数码' }],
    notice_key: 'rank.notice',
    next_cursor: null,
  });
  expect(
    body.data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]),
  ).toEqual([
    [1, 'synthetic-http-a', '10万+'],
    [2, 'synthetic-http-b', null],
  ]);
  expect(f.calls).toEqual([
    expect.objectContaining({ platform: 'taobao', category: 'synthetic-digital' }),
  ]);
});

it('[AC-B1-28h#26] category 不在该频道类目里 → 400/20001 data.fields=[category]', async () => {
  const f = await httpFixture();
  app = f.app;
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);

  await expectError(await f.request({ category: 'synthetic-unknown' }), 400, 20001, {
    fields: ['category'],
  });
});

it('[AC-B1-28h#27] 非法游标与别的平台的游标 → 400/20001 data.fields=[cursor]', async () => {
  const f = await httpFixture();
  app = f.app;
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', 'synthetic_jd_sales')]);
  f.setPage('taobao', TB_CHANNEL, null, 1, series('tb', PAGE_SIZE), true);

  await expectError(await f.request({ cursor: 'synthetic-not-a-cursor' }), 400, 20001, {
    fields: ['cursor'],
  });
  const first = await f.request();
  expect(first.statusCode).toBe(200);
  const cursor = first.json<{ data: HotRankData }>().data.next_cursor;
  expect(typeof cursor).toBe('string');
  await expectError(await f.request({ platform: 'jd', cursor: cursor! }), 400, 20001, {
    fields: ['cursor'],
  });
});

it('[AC-B1-28h#28] 联盟故障无缓存 → 503/50304 只带 data.platform、不带 reason；没有合规频道 → 503/50304 reason=rank_unavailable', async () => {
  const f = await httpFixture();
  app = f.app;
  f.fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));

  const outage = await expectError(await f.request(), 503, 50304, { platform: 'taobao' });
  expect(outage.data).not.toHaveProperty('reason');

  f.setChannels([]);
  await expectError(await f.request(), 503, 50304, {
    platform: 'taobao',
    reason: 'rank_unavailable',
  });
});
