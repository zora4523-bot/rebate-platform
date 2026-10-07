import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createLinkOpen,
  LinkOpenService,
} from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import type {
  LinkOpenCachedJump,
  LinkOpenJump,
} from '../../../../apps/api/src/modules/linking/index.ts';
import {
  FixedClock,
  GovernanceError,
  REQUEST_CHECKS,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  attempts,
  cacheKey,
  databaseFixture,
  fixture,
  reprice,
  source,
} from '../open-requote/kit.ts';
import { conversionFixture, demoInput, settled } from './kit.ts';

// Since B1-02h the api entry refuses a contract route that takes a token unless its request
// check plan runs the token check (BR-ID-01 ②). The plan here keeps the real signature check and
// adds the real token check; these requests carry no Authorization (x-auth optional on open), so
// its token service and session lookup are never reached.
const tokenCheck = createTokenCheck({
  tokens: {
    verifyAccess: async () => {
      throw new Error('synthetic token service not used');
    },
  } as unknown as Parameters<typeof createTokenCheck>[0]['tokens'],
  sessions: { find: async () => null } as unknown as Parameters<
    typeof createTokenCheck
  >[0]['sessions'],
});

const database = databaseFixture(createTestDatabase);
const ROOT = new URL('../../../../', import.meta.url);

async function setup(platform: 'jd' | 'pdd', productKey?: string) {
  const f = fixture(database());
  const c = conversionFixture(platform);
  const input = await demoInput(c);
  const raw = input.owner.link.raw_item_id!;
  const item = platform === 'jd' ? { platform, itemId: raw } : { platform, goods_sign: raw };
  const row = await source(f, 2990n, item, { scene: 'detail' });
  const product = productKey ?? input.owner.link.product_key!;
  await database()
    .updateTable('links')
    .set({
      product_key: product,
      raw_item_id: raw,
      promo_url: 'https://example.test/other-promoter?pid=untrusted',
    })
    .where('link_id', '=', row.link_id)
    .execute();
  if (f.state.price.kind === 'available') {
    f.state.price = {
      kind: 'available',
      input: {
        ...f.state.price.input,
        ref: { ...f.state.price.input.ref, productKey: product, rawItemId: raw },
      },
    };
  }
  f.config.set(`convert.enabled.${platform}`, true);
  f.config.set('attr.click_code.jd', false);
  f.config.set('attr.click_code.pdd', false);
  const { conversion: unusedConversion, ...requote } = f.options;
  void unusedConversion;
  const options = {
    ...requote,
    registry: c.options.registry,
    logger: c.options.logger,
    attrCodes: { attrCode: c.attrCode },
  };
  return { f, c, row: { ...row, product_key: product, raw_item_id: raw }, options };
}

interface Response {
  statusCode: number;
  json(): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'POST';
    url: string;
    payload: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
interface ModuleShape {
  providers?: unknown[];
  [key: string]: unknown;
}

// The real open service is injected, never a canned response. Controllers, schema,
// signature verification and the global error filter are the application's own.
// CallerContext remains the database fixture's server-side context, as in the existing HTTP kit.
async function withHttp(
  service: LinkOpenService,
  clock: FixedClock,
  linkId: string,
  check: (send: (body: object) => Promise<Response>) => Promise<void>,
) {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: unknown): ModuleShape };
  };
  const { LinkingModule } = (await import(
    new URL('apps/api/src/modules/linking/linking.module.ts', ROOT).href
  )) as { LinkingModule: { forRoot(options: unknown): ModuleShape } };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      overrides: { clock: FixedClock; config: ReturnType<typeof loadConfig>; logger: RootLogger },
    ): Promise<HttpApp>;
  };
  const signingMaterial = randomBytes(32).toString('hex');
  const deviceId = '0199a3b4-5c6d-7000-8000-000000000077';
  const signature = createSignatureCheck({
    clock,
    devices: {
      findActive: async () => ({ appId: 'couli', deviceId, installSecret: signingMaterial }),
    },
    redis: {
      namespace: () => ({
        get: async () => null,
        set: async () => undefined,
        eval: async () => 'OK',
      }),
    },
  });
  const originalRoot = AppModule.forEntry.bind(AppModule);
  const originalLinking = LinkingModule.forRoot.bind(LinkingModule);
  const linkSpy = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((options) => {
    const module = originalLinking(options);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: LinkOpenService, useValue: service }],
    };
  });
  const rootSpy = vi.spyOn(AppModule, 'forEntry').mockImplementation((options) => {
    const module = originalRoot(options);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        {
          provide: REQUEST_CHECKS,
          useValue: { checks: [signature, tokenCheck], bufferWhen: isContractSignedRoute },
        },
      ],
    };
  });
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      clock,
      config: loadConfig({ APP_ENV: 'test' }),
      logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
    });
    await app.init();
    const server = app;
    await check(async (body) => {
      const payload = JSON.stringify(body);
      const path = `/v1/links/${linkId}/open`;
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const sign = createHmac('sha256', signingMaterial)
        .update(
          ['POST', path, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
            '\n',
          ),
        )
        .digest('hex');
      return server.inject({
        method: 'POST',
        url: path,
        payload,
        headers: {
          'content-type': 'application/json',
          'x-app-id': 'couli',
          'x-app-version': '1.0.0',
          'x-platform': 'ios',
          'x-device-id': deviceId,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign,
          'x-trace-id': 'synthetic-review-http',
          'idempotency-key': `synthetic-review-${linkId}`,
        },
      });
    });
  } finally {
    rootSpy.mockRestore();
    linkSpy.mockRestore();
    await app?.close();
  }
}

async function validateErrorResponse(body: unknown) {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const validate = createValidatorCompiler()({
    schema: doc.components.schemas['ErrorEnvelope']!,
    httpPart: 'body',
  });
  expect(validate(body)).toBe(true);
  expect(validate.errors ?? []).toEqual([]);
}

it.each([
  ['jd', 'jd:12345', 'item.jd.com', '/12345.html', ''],
  ['pdd', 'pdd:67890', 'mobile.yangkeduo.com', '/goods.html', '?goods_id=67890'],
] as const)(
  '[AC-B1-06e#37] BR-PRICE-08/13 %s：no_rebate 转链熔断仍返回纯商品页，不新增报价快照',
  async (platform, productKey, host, path, search) => {
    const { f, c, row, options } = await setup(platform, productKey);
    c.convert.mockRejectedValue(
      new GovernanceError('circuit_open', 'synthetic-union', 'synthetic circuit open'),
    );
    // A changed live price must not accidentally register a new quoted card for this action.
    reprice(f, 3190n);
    const quotedLinks = () =>
      database()
        .selectFrom('links')
        .select(['link_id', 'quoted_final_price_fen', 'quoted_coupon_fen', 'quoted_at'])
        .where('app_id', '=', row.app_id)
        .where('quoted_final_price_fen', 'is not', null)
        .orderBy('link_id')
        .execute();
    const before = await quotedLinks();
    const service = createLinkOpen(options);
    const result = await settled(() =>
      service.open({ ...f.request(row.link_id), noRebate: true, installed: 'true' }),
    );
    expect(result).toMatchObject({
      status: 200,
      envelope: {
        code: 0,
        data: {
          new_rebate_min_fen: 0,
          new_rebate_max_fen: 0,
          jump: { primary: { type: 'h5', value: expect.any(String) }, fallbacks: [] },
        },
      },
    });
    const { jump } = (result as { envelope: { data: { jump: LinkOpenJump } } }).envelope.data;
    const url = new URL(jump.primary.value!);
    expect({
      protocol: url.protocol,
      host: url.host,
      path: url.pathname,
      search: url.search,
      hash: url.hash,
      username: url.username,
      password: url.password,
    }).toEqual({ protocol: 'https:', host, path, search, hash: '', username: '', password: '' });
    expect(c.convert).toHaveBeenCalledTimes(1);
    expect(await quotedLinks()).toEqual(before);
  },
);

it.each(['取价成功', '取价失败'] as const)(
  '[AC-B1-06e#38] BR-PROD-10：京东开关关闭且%s，有效缓存也只能返回 HTTP 503/50301',
  async (priceOutcome) => {
    const { f, c, row, options } = await setup('jd');
    const cached: LinkOpenCachedJump = {
      fetchedAt: f.clock.now().toISOString(),
      jump: {
        primary: { type: 'h5', value: 'https://example.test/cached-rebate' },
        fallbacks: [],
        expire_at: new Date(f.clock.now().getTime() + 900000).toISOString(),
      },
    };
    await f.cache.put(cacheKey(row), cached);
    expect(await f.cache.get(cacheKey(row))).toEqual(cached);
    f.clock.advanceMs(1000);
    f.config.set('convert.enabled.jd', false);
    if (priceOutcome === '取价失败')
      f.fetch.mockRejectedValue(new Error('synthetic requote failure'));
    const service = createLinkOpen(options);
    await withHttp(service, f.clock, row.link_id, async (send) => {
      const result = await settled(async () => {
        const response = await send({ installed: 'true' });
        return { status: response.statusCode, envelope: response.json() };
      });
      expect(result).toMatchObject({ status: 503, envelope: { code: 50301 } });
      const envelope = (result as { envelope: { data?: unknown } }).envelope;
      await validateErrorResponse(envelope);
      expect(envelope).not.toHaveProperty('jump');
      expect(envelope.data ?? {}).not.toHaveProperty('jump');
    });
    expect(c.convert).not.toHaveBeenCalled();
    expect(await attempts(database(), row.link_id)).toEqual([]);
  },
);

it('[AC-B1-06e#39] BR-ATTR-27：同用户同 link 从 iOS 切换鸿蒙且 installed=true，缓存不能带入 universal_link', async () => {
  const { f, row, options } = await setup('jd');
  // Preserve every key field the service supplies, including future client dimensions;
  // the older shared fixture deliberately projects only the original identity fields.
  const entries = new Map<string, LinkOpenCachedJump>();
  f.cache.get.mockImplementation(async (key) => entries.get(JSON.stringify(key)) ?? null);
  f.cache.put.mockImplementation(async (key, value) => {
    entries.set(JSON.stringify(key), value);
  });
  const service = createLinkOpen(options);
  const first = await settled(() =>
    service.open({ ...f.request(row.link_id), client: 'ios', installed: 'true' }),
  );
  expect(first).toMatchObject({ status: 200, envelope: { code: 0 } });
  const firstJump = (first as { envelope: { data: { jump: LinkOpenJump } } }).envelope.data.jump;
  expect([firstJump.primary, ...firstJump.fallbacks].map((step) => step.type)).toEqual([
    'scheme',
    'universal_link',
    'h5',
  ]);
  expect(f.cache.put).toHaveBeenCalled();
  expect(entries.size).toBeGreaterThan(0);
  f.clock.advanceMs(3001);
  const second = await settled(() =>
    service.open({ ...f.request(row.link_id), client: 'harmony', installed: 'true' }),
  );
  expect(second).toMatchObject({ status: 200, envelope: { code: 0 } });
  const secondJump = (second as { envelope: { data: { jump: LinkOpenJump } } }).envelope.data.jump;
  expect([secondJump.primary, ...secondJump.fallbacks].map((step) => step.type)).toEqual([
    'scheme',
    'h5',
  ]);
});
