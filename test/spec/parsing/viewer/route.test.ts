import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type {
  CatalogCardEntryOptions,
  Viewer,
  ViewerContext,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ParsingOptions } from '../../../../apps/api/src/modules/parsing/index.ts';
import type { RequestCheck } from '../../../../apps/api/src/modules/platform/index.ts';
import { fixture, URL_A, URL_B, URL_C } from '../core/kit.ts';
import { contract, HEADERS, PATH, validResponse, type HttpApp } from '../http/kit.ts';
import { buildViewerApp, viewerOf } from './kit.ts';

// Same boundary as the frozen http rule tests: HTTP registration, validation, parsing and catalog
// card logic stay real; only synthetic union/config/catalog reads, quotes and link storage are
// replaced. The viewerContext the route hands to the card entry survives untouched.
const state = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof fixture> | undefined,
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
      return actual.createParsing({ ...options, ...f.options, cards: options.cards });
    },
  };
});

// Publishes a verified device without Redis or a port. Its id is none of the viewers' on purpose:
// only the injected viewer can put a device on a link here, not the request.
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
          request.verifiedDevice = { appId: 'couli', deviceId: 'synthetic-verified-device' };
        };
        checks.add(check);
        return check;
      },
      isSignatureCheck: (check: RequestCheck) => checks.has(check),
    };
  },
);

const USER: Viewer = {
  appId: 'couli',
  userId: 'synthetic-user',
  deviceId: 'synthetic-viewer-device',
};
const DEVICE_GUEST: Viewer = { appId: 'couli', userId: null, deviceId: 'synthetic-device' };
const FORGED = { 'x-user-id': 'synthetic-forged-user', 'x-device-id': 'synthetic-forged-device' };
const INTERNAL_FAILURE = 50001;

let app: HttpApp | undefined;
let f: ReturnType<typeof fixture>;
let schemas: Awaited<ReturnType<typeof contract>>;
const lines: string[] = [];

beforeAll(async () => {
  schemas = await contract();
});
beforeEach(() => {
  f = fixture();
  state.current = f;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  state.current = undefined;
});

async function start(context: ViewerContext) {
  app = await buildViewerApp(lines, context);
  lines.length = 0;
}

function post(payload: unknown, headers: Record<string, string> = {}) {
  return app!.inject({
    method: 'POST',
    url: PATH,
    headers: { ...HEADERS, ...headers },
    payload: JSON.stringify(payload),
  });
}

function expectOneCardFor(viewer: Viewer) {
  expect(f.quote).toHaveBeenCalledTimes(1);
  expect(f.quote.mock.calls[0]![1]).toEqual(viewer);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.register.mock.calls[0]![0].viewer).toEqual(viewer);
}

it.each(['clipboard', 'search', 'share_ext'])(
  '[AC-B1-07c#1] %s 已登录出卡：报价第二参与 register 的查看者都取自注入的查看者，只登记不转链',
  async (scene) => {
    await start(viewerOf(USER));
    const results = validResponse(await post({ text: URL_A, scene }), schemas);
    expect(results).toHaveLength(1);
    expect(results[0]?.card).toMatchObject({
      product_key: 'tb:a',
      link_id: 'synthetic-link:tb:a',
    });
    expectOneCardFor(USER);
    expect(f.register.mock.calls[0]![0]).toMatchObject({
      ref: { appId: 'couli', productKey: 'tb:a' },
      entrySource: 'parse',
    });
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07c#2] 卡面返利是报价器按当前登录用户算的结果，不是游客的报价', async () => {
  f.quote.mockImplementation(async (_item, viewer, context) => {
    const fen = viewer.userId === USER.userId ? 500n : 300n;
    return {
      rebateMinFen: fen,
      rebateMaxFen: fen,
      estNetPriceFen: null,
      rebateBasis: context?.rebateBasis ?? 'normal',
    };
  });
  await start(viewerOf(USER));
  const results = validResponse(await post({ text: URL_A, scene: 'clipboard' }), schemas);
  expect(results).toHaveLength(1);
  expect(results[0]?.card).toMatchObject({ rebate_min_fen: 500, rebate_max_fen: 500 });
});

it('[AC-B1-07c#3] 一条消息三个命中：每张卡都按同一查看者报价和登记', async () => {
  await start(viewerOf(USER));
  const results = validResponse(
    await post({ text: `${URL_A} ${URL_B} ${URL_C}`, scene: 'search' }),
    schemas,
  );
  expect(results.map((result) => result.card?.['product_key'])).toEqual([
    'tb:a',
    'jd:i_b',
    'pdd:c',
  ]);
  expect(f.quote.mock.calls.map(([, viewer]) => viewer)).toEqual([USER, USER, USER]);
  expect(f.register.mock.calls.map(([input]) => input.viewer)).toEqual([USER, USER, USER]);
});

it('[AC-B1-07c#4] 设备游客：userId 为空，deviceId 随查看者传到报价与 register', async () => {
  await start(viewerOf(DEVICE_GUEST));
  const results = validResponse(
    await post({ text: URL_A, scene: 'clipboard' }, { 'x-device-id': 'synthetic-header-device' }),
    schemas,
  );
  expect(results).toHaveLength(1);
  expectOneCardFor(DEVICE_GUEST);
});

it.each([
  ['已登录查看者', USER],
  ['设备游客', DEVICE_GUEST],
] as const)('[AC-B1-07c#5] %s：伪造身份头不起作用，结果只认注入的查看者', async (_name, viewer) => {
  await start(viewerOf(viewer));
  const results = validResponse(await post({ text: URL_A, scene: 'clipboard' }, FORGED), schemas);
  expect(results).toHaveLength(1);
  expectOneCardFor(viewer);
  expect(JSON.stringify(f.quote.mock.calls[0]![1])).not.toContain('forged');
  expect(JSON.stringify(f.register.mock.calls[0]![0].viewer)).not.toContain('forged');
});

// The app scope is the viewer's: a viewer of another app must reach the card entry's app check, so
// a route that keeps the request's X-App-Id beside the viewer's user would card here instead.
it('[AC-B1-07c#6] appId 也取自查看者：查看者属于别的 App 时该命中失败，不报价不登记', async () => {
  await start(viewerOf({ ...USER, appId: 'synthetic_other_app' }));
  const results = validResponse(await post({ text: URL_A, scene: 'clipboard' }), schemas);
  expect(results).toEqual([
    { hit: { platform: 'taobao', kind: 'url', raw: URL_A }, error_code: INTERNAL_FAILURE },
  ]);
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

// "Not injected" is the only way back to a guest: an injected viewer that fails must not quietly
// turn a signed-in user's card into a guest link.
it('[AC-B1-07c#7] 注入的查看者读取失败时该命中失败，不退回游客报价和登记', async () => {
  await start({ current: () => Promise.reject(new Error('synthetic identity failure')) });
  const results = validResponse(await post({ text: URL_A, scene: 'clipboard' }), schemas);
  expect(results).toEqual([
    { hit: { platform: 'taobao', kind: 'url', raw: URL_A }, error_code: INTERNAL_FAILURE },
  ]);
  expect(f.quote).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});
