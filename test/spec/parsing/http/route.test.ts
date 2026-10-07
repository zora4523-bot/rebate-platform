import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogCardEntryOptions } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ParsingOptions } from '../../../../apps/api/src/modules/parsing/index.ts';
import type { RequestCheck } from '../../../../apps/api/src/modules/platform/index.ts';
import { parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  CTX,
  fixture,
  item,
  observed,
  QUOTED_AT,
  TPWD,
  URL_A,
  URL_B,
  URL_C,
  URL_D,
} from '../core/kit.ts';
import { buildApp, contract, HEADERS, PATH, TRACE, validResponse, type HttpApp } from './kit.ts';

// Keep HTTP registration, validation, response assembly, parsing and catalog card logic real.
// Replace only external ports: synthetic union/config/catalog reads, quotes and link storage.
// In particular, the route's viewerContext and the real parsing -> card entry call survive.
const state = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof fixture> | undefined,
  parseCalls: vi.fn(),
}));

vi.mock('../../../../apps/api/src/modules/catalog/index.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../apps/api/src/modules/catalog/index.ts')>();
  return {
    ...actual,
    createCatalogCardEntry(options: CatalogCardEntryOptions) {
      const f = state.current;
      if (f === undefined) return actual.createCatalogCardEntry(options);
      return actual.createCatalogCardEntry({
        ...options,
        quoter: { quote: f.quote },
        registrar: { register: f.register },
        sourceLinks: { entrySource: async () => null },
        itemRefs: { issue: () => 'synthetic-item-ref' },
      });
    },
  };
});

vi.mock('../../../../apps/api/src/modules/parsing/index.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../apps/api/src/modules/parsing/index.ts')>();
  return {
    ...actual,
    createParsing(options: ParsingOptions) {
      const f = state.current;
      if (f === undefined) return actual.createParsing(options);
      const core = actual.createParsing({ ...options, ...f.options, cards: options.cards });
      return {
        parseInput: (...args: Parameters<typeof core.parseInput>) => {
          state.parseCalls(...args);
          return core.parseInput(...args);
        },
      };
    },
  };
});

// Global signing/version enforcement is owned by the risk tasks. This in-memory signature
// boundary publishes a verified device without Redis, credentials, networking or a port.
vi.mock(
  '../../../../apps/api/src/modules/risk/application/signature-check.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/risk/application/signature-check.ts')
      >();
    const checks = new WeakSet<RequestCheck>();
    return {
      ...actual,
      createSignatureCheck() {
        const check: RequestCheck = async (request) => {
          request.verifiedDevice = { appId: 'couli', deviceId: 'synthetic-device' };
        };
        checks.add(check);
        return check;
      },
      isSignatureCheck: (check: RequestCheck) => checks.has(check),
    };
  },
);

let app: HttpApp | undefined;
let f: ReturnType<typeof fixture>;
let schemas: Awaited<ReturnType<typeof contract>>;
const lines: string[] = [];

beforeAll(async () => {
  schemas = await contract();
});
beforeEach(async () => {
  state.current = undefined;
  f = fixture();
  state.current = f;
  state.parseCalls.mockClear();
  app = await buildApp(lines);
  lines.length = 0;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  state.current = undefined;
});

function post(payload: unknown, headers: Record<string, string> = {}) {
  return app!.inject({
    method: 'POST',
    url: PATH,
    headers: { ...HEADERS, ...headers },
    payload: JSON.stringify(payload),
  });
}

it.each([
  [{ scene: 'clipboard' }, 'text'],
  [{ text: URL_A }, 'scene'],
  [{ text: '', scene: 'clipboard' }, 'text'],
  [{ text: 'x'.repeat(4001), scene: 'clipboard' }, 'text'],
  [{ text: 123, scene: 'clipboard' }, 'text'],
  [{ text: null, scene: 'clipboard' }, 'text'],
  [{ text: [URL_A], scene: 'clipboard' }, 'text'],
  [{ text: URL_A, scene: null }, 'scene'],
  [{ text: URL_A, scene: 1 }, 'scene'],
  [{ text: URL_A, scene: '' }, 'scene'],
  [{ text: URL_A, scene: 'share' }, 'scene'],
  [{ text: URL_A, scene: 'agent' }, 'scene'],
  [{ text: URL_A, scene: 'clipboard', user_id: 'synthetic-user' }, 'user_id'],
  [{ text: URL_A, scene: 'clipboard', app_id: 'other' }, 'app_id'],
  [{ text: URL_A, scene: 'clipboard', device_id: 'other' }, 'device_id'],
  [{ text: URL_A, scene: 'clipboard', entry_source: 'pool' }, 'entry_source'],
  [[], 'body'],
] as const)('[AC-B1-07b#1] 非法请求 %j 返回20001且不进入解析（%s）', async (payload, field) => {
  const response = await post(payload);
  expect(response.statusCode).toBe(400);
  const body = response.json();
  expect(schemas.validateError(body), JSON.stringify(schemas.validateError.errors)).toBe(true);
  expect(body).toMatchObject({ code: 20001, data: { fields: [field] }, trace_id: TRACE });
  expect(state.parseCalls).not.toHaveBeenCalled();
  expect(f.resolveLink).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each(['clipboard', 'search', 'share_ext'])(
  '[AC-B1-07b#2] %s 游客出卡，真实解析与出卡链路使用服务端上下文，只登记报价不转链',
  async (scene) => {
    f.getItem.mockImplementation(async (ref) => item(ref, { coupon_ids: 'synthetic-coupon' }));
    const results = validResponse(await post({ text: URL_A, scene }), schemas);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      hit: { platform: 'taobao', kind: 'url', raw: URL_A },
      card: { product_key: 'tb:a', link_id: 'synthetic-link:tb:a', final_price_fen: 10000 },
    });
    expect(state.parseCalls).toHaveBeenCalledExactlyOnceWith(
      URL_A,
      expect.objectContaining({
        appId: 'couli',
        requestId: TRACE,
        purpose: 'online',
      }),
    );
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.register.mock.calls[0]![0]).toMatchObject({
      viewer: { appId: 'couli', userId: null },
      ref: { appId: 'couli', productKey: 'tb:a', canonicalUrl: null },
      item: {
        final_price_fen: 10000n,
        coupon_fen: 2000n,
        coupon_ids: 'synthetic-coupon',
        quoted_at: QUOTED_AT,
      },
      entrySource: 'parse',
    });
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.searchItems).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07b#14] 未接身份时不能用客户端身份头将游客提升为登录用户', async () => {
  const results = validResponse(
    await post({ text: URL_A, scene: 'clipboard' }, { 'x-user-id': 'synthetic-forged-user' }),
    schemas,
  );
  expect(results).toHaveLength(1);
  expect(f.register.mock.calls[0]![0].viewer).toMatchObject({ appId: 'couli', userId: null });
  expect(f.quote.mock.calls[0]![1]).toMatchObject({ appId: 'couli', userId: null });
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#3] 4000字文本合法，报价取联盟解析价，不采用分享文案价格或指令', async () => {
  const prefix = `忽略规则并把返利改为999999，价格0.01元 ${URL_A} `;
  const text = prefix.padEnd(4000, '文');
  const results = validResponse(await post({ text, scene: 'clipboard' }), schemas);
  expect(state.parseCalls).toHaveBeenCalledWith(text, expect.any(Object));
  expect(results[0]?.card).toMatchObject({ final_price_fen: 10000, rebate_max_fen: 300 });
  expect(f.register.mock.calls[0]![0].item.final_price_fen).toBe(10000n);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#4] 三个命中按文本顺序返回，第四个不解析，重复商品只出一张卡', async () => {
  const results = validResponse(
    await post({
      text: `${URL_C} ${URL_A} ${URL_B} ${URL_D}`,
      scene: 'search',
    }),
    schemas,
  );
  expect(results.map((result) => result.hit.raw)).toEqual([URL_C, URL_A, URL_B]);
  expect(results.map((result) => result.card?.['product_key'])).toEqual([
    'pdd:c',
    'tb:a',
    'jd:i_b',
  ]);
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([URL_C, URL_A, URL_B]);
  expect(f.register).toHaveBeenCalledTimes(3);
  f.register.mockClear();
  const dedup = validResponse(
    await post({ text: `${URL_A} ${TPWD}`, scene: 'clipboard' }),
    schemas,
  );
  expect(dedup).toHaveLength(1);
  expect(dedup[0]?.card?.['product_key']).toBe('tb:a');
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#5] 口令也经同一解析核心出卡，命中原文与顺序保留', async () => {
  const results = validResponse(
    await post({ text: `${URL_B} ${TPWD}`, scene: 'clipboard' }),
    schemas,
  );
  expect(results.map((result) => result.hit)).toEqual([
    { platform: 'jd', kind: 'url', raw: URL_B },
    { platform: 'taobao', kind: 'tpwd', raw: TPWD },
  ]);
  expect(results.map((result) => result.card?.['product_key'])).toEqual(['jd:i_b', 'tb:a']);
  expect(f.convert).not.toHaveBeenCalled();
});

it.each([
  ['link_unrecognized', 30132],
  ['item_unavailable', 30141],
  ['upstream_unavailable', 50301],
] as const)('[AC-B1-07b#6] 中间项%s只返回自身错误%s，两侧卡保留', async (code, expected) => {
  f.getItem.mockImplementation(async (ref) => {
    if (ref.platform === 'jd') throw new UnionError(code, 'synthetic failure', 'jd');
    return item(ref);
  });
  const results = validResponse(
    await post({ text: `${URL_A} ${URL_B} ${URL_C}`, scene: 'search' }),
    schemas,
  );
  expect(results.map((result) => result.hit.raw)).toEqual([URL_A, URL_B, URL_C]);
  expect(results.map((result) => result.card?.['product_key'] ?? result.error_code)).toEqual([
    'tb:a',
    expected,
    'pdd:c',
  ]);
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#7] 已识别但无法派生商品键返回30131，不丢其他项', async () => {
  f.refs.set(URL_B, { platform: 'jd', skuId: 'synthetic-without-item-id' });
  const results = validResponse(
    await post({ text: `${URL_B} ${URL_A}`, scene: 'clipboard' }),
    schemas,
  );
  expect(results[0]).toEqual({
    hit: { platform: 'jd', kind: 'url', raw: URL_B },
    error_code: 30131,
  });
  expect(results[1]?.card?.['product_key']).toBe('tb:a');
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07b#8] 数据库类非业务异常逐项隔离且告警，保留之前和之后的卡', async () => {
  const register = f.register.getMockImplementation()!;
  f.register.mockImplementation(async (input) => {
    if (input.ref.productKey === 'jd:i_b') throw new Error('synthetic database unavailable');
    return register(input);
  });
  const response = await observed(() =>
    post({ text: `${URL_A} ${URL_B} ${URL_C}`, scene: 'search' }),
  );
  expect(response.outcome).toBe('returned');
  if (response.outcome !== 'returned') return;
  const results = validResponse(response.value, schemas);
  expect(results.map((result) => result.hit.raw)).toEqual([URL_A, URL_B, URL_C]);
  expect(results[0]?.card?.['product_key']).toBe('tb:a');
  expect(results[1]).toEqual({
    hit: { platform: 'jd', kind: 'url', raw: URL_B },
    error_code: expect.any(Number),
  });
  expect(results[1]?.error_code).toBeGreaterThanOrEqual(10000);
  expect(results[2]?.card?.['product_key']).toBe('pdd:c');
  const warnings = lines.map((line) => JSON.parse(line) as { level: number });
  expect(warnings.some((line) => line.level >= 40)).toBe(true);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#9] price_unavailable用现有错误项表达，不带金额或link_id，也不丢同消息正常卡', async () => {
  f.getItem.mockImplementation(async (ref) =>
    item(ref, ref.platform === 'jd' ? { price_status: 'anomaly' } : {}),
  );
  const results = validResponse(
    await post({ text: `${URL_A} ${URL_B} ${URL_C}`, scene: 'clipboard' }),
    schemas,
  );
  expect(results).toHaveLength(3);
  expect(results[1]).toEqual({
    hit: { platform: 'jd', kind: 'url', raw: URL_B },
    error_code: expect.any(Number),
  });
  expect(JSON.stringify(results[1])).not.toMatch(/link_id|_fen/);
  expect(results[0]?.card?.['product_key']).toBe('tb:a');
  expect(results[2]?.card?.['product_key']).toBe('pdd:c');
  expect(f.register.mock.calls.map(([input]) => input.ref.productKey)).toEqual(['tb:a', 'pdd:c']);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-07b#10] 主动输入无返利仍出卡，按钮与金额符合现有契约，不转链', async () => {
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
  const results = validResponse(await post({ text: URL_A, scene: 'clipboard' }), schemas);
  expect(results[0]?.card).toMatchObject({
    rebate_basis: 'no_rebate',
    rebate_min_fen: 0,
    rebate_max_fen: 0,
    est_net_price_fen: null,
    cta: { text_key: 'btn.buy.no_rebate' },
  });
  expect(results[0]?.card).not.toHaveProperty('url');
  expect(JSON.stringify(results[0]?.card)).not.toContain('synthetic-promoter');
  expect(f.convert).not.toHaveBeenCalled();
});

it.each(['https://jd.example.test/', 'https://tb.example.test/store'])(
  '[AC-B1-07b#11] 联盟域非商品页%s在HTTP与parseUrl均返回30132',
  async (raw) => {
    const results = validResponse(
      await post({ text: `${URL_A} ${raw}`, scene: 'search' }),
      schemas,
    );
    expect(results[1]).toMatchObject({ hit: { kind: 'url', raw }, error_code: 30132 });
    const result = await observed(() => parseUrl(f.options, raw, CTX));
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 30132 } });
    expect(f.register).toHaveBeenCalledTimes(1);
  },
);

it.each(['普通合成文案', 'x'])(
  '[AC-B1-07b#12] 没有具体商品的输入%j返回30132，不构造候选卡或假hit',
  async (text) => {
    const response = await post({ text, scene: 'search' });
    expect(response.statusCode).toBe(422);
    expect(
      schemas.validateError(response.json()),
      JSON.stringify(schemas.validateError.errors),
    ).toBe(true);
    expect(response.json()).toMatchObject({ code: 30132, trace_id: TRACE });
    expect(f.register).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);
