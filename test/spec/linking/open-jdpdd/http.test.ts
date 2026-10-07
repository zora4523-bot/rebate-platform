import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  LinkOpenService,
  type LinkOpenInput,
} from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  createRootLogger,
  loadConfig,
  isContractSignedRoute,
  type HandlerResult,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { EXPIRES, LINK, START } from './kit.ts';

// Only dependency ports are replaced. Controllers, route schema, Fastify and the global error
// filter come from the real createHttpApp. Signature verification stays real, Redis stays local.
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
interface RootModule {
  forEntry(options: unknown): ModuleShape;
}
interface LinkingModuleShape {
  forRoot(options: unknown): ModuleShape;
}
const ROOT = new URL('../../../../', import.meta.url);
const TRACE = 'synthetic-open-http';
const RESULT = {
  attempt_id: 'synthetic-attempt',
  jump: {
    primary: { type: 'h5', value: 'https://example.test/converted' },
    fallbacks: [],
    expire_at: EXPIRES,
  },
  price_changed: false,
  old_final_price_fen: 2990,
  new_final_price_fen: 2990,
  new_link_id: null,
  requote_failed: false,
  new_rebate_min_fen: 229,
  new_rebate_max_fen: 229,
  no_rebate_cause: null,
  availability: 'ok',
  quoted_at: START,
};

async function withHttp(
  check: (
    send: (body: object, headers?: Record<string, string | undefined>) => Promise<Response>,
    open: ReturnType<typeof vi.fn<(input: LinkOpenInput) => Promise<HandlerResult>>>,
  ) => Promise<void>,
) {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: RootModule;
  };
  const { LinkingModule } = (await import(
    new URL('apps/api/src/modules/linking/linking.module.ts', ROOT).href
  )) as { LinkingModule: LinkingModuleShape };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      overrides: { config: ReturnType<typeof loadConfig>; clock: FixedClock; logger: RootLogger },
    ): Promise<HttpApp>;
  };
  const clock = new FixedClock(START);
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
  const open = vi.fn<(input: LinkOpenInput) => Promise<HandlerResult>>(async () => ({
    status: 200,
    envelope: { code: 0, msg: 'ok', trace_id: TRACE, data: RESULT },
  }));
  const originalRoot = AppModule.forEntry.bind(AppModule);
  const originalLinking = LinkingModule.forRoot.bind(LinkingModule);
  const linkSpy = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((options) => {
    const module = originalLinking(options);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: LinkOpenService, useValue: { open } }],
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
          useValue: { checks: [signature], bufferWhen: isContractSignedRoute },
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
    await check(async (body, overrides = {}) => {
      const payload = JSON.stringify(body);
      const path = `/v1/links/${LINK}/open`;
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const sign = createHmac('sha256', signingMaterial)
        .update(
          ['POST', path, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
            '\n',
          ),
        )
        .digest('hex');
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-app-id': 'couli',
        'x-app-version': '1.0.0',
        'x-platform': 'ios',
        'x-device-id': deviceId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign,
        'x-trace-id': TRACE,
        'idempotency-key': 'synthetic-http-open',
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete headers[name];
        else headers[name] = value;
      }
      return server.inject({ method: 'POST', url: path, payload, headers });
    }, open);
  } finally {
    rootSpy.mockRestore();
    linkSpy.mockRestore();
    await app?.close();
  }
}

async function validateResponse(body: unknown, schemaName: 'OpenLinkResponse' | 'ErrorEnvelope') {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const validate = createValidatorCompiler()({
    schema: doc.components.schemas[schemaName]!,
    httpPart: 'body',
  });
  expect(validate(body)).toBe(true);
  expect(validate.errors ?? []).toEqual([]);
}

it('[AC-B1-06e#28] POST open 已注册，取 link_id、幂等键和请求头的端，响应通过契约', async () => {
  await withHttp(async (send, open) => {
    const response = await send(
      { installed: 'false', no_rebate: true, no_rebate_reason: 'auth_failed' },
      { 'x-platform': 'android' },
    );
    expect(response.statusCode).toBe(200);
    await validateResponse(response.json(), 'OpenLinkResponse');
    expect(response.json()).toMatchObject({ code: 0, data: RESULT });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        linkId: LINK,
        idempotencyKey: 'synthetic-http-open',
        traceId: TRACE,
        client: 'android',
        installed: 'false',
        noRebate: true,
        noRebateReason: 'auth_failed',
      }),
    );
  });
});

it('[AC-B1-06e#29] BR-ATTR-27/08：HTTP 缺省 installed=unknown，no_rebate=false', async () => {
  await withHttp(async (send, open) => {
    const response = await send({});
    expect(response.statusCode).toBe(200);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ installed: 'unknown', noRebate: false, client: 'ios' }),
    );
  });
});

it.each([
  { installed: true },
  { installed: 'yes' },
  { no_rebate: 'true' },
  { no_rebate_reason: 'relation_conflict' },
  { user_id: 'synthetic-attacker' },
  { attr_code: 'evil0001' },
  { pid: 'evil-pid' },
  { platform: 'pdd' },
  { client: 'h5' },
] as const)('[AC-B1-06e#30] HTTP 拒绝契约外字段/类型 %j，不能注入身份或端', async (body) => {
  await withHttp(async (send, open) => {
    const response = await send(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    await validateResponse(response.json(), 'ErrorEnvelope');
    expect(open).not.toHaveBeenCalled();
  });
});

it('[AC-B1-06e#31] open 必须带 Idempotency-Key，无键不进入用例', async () => {
  await withHttp(async (send, open) => {
    const response = await send({}, { 'idempotency-key': undefined });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(open).not.toHaveBeenCalled();
  });
});

it.each([
  [10001, 401],
  [30144, 404],
  [50301, 503],
  [50303, 503],
] as const)(
  '[AC-B1-06e#32] HTTP 原样保留用例错误 %s 与状态 %s，不包成成功',
  async (code, status) => {
    await withHttp(async (send, open) => {
      open.mockResolvedValue({
        status,
        envelope: { code, msg: 'synthetic business failure', trace_id: TRACE },
      });
      const response = await send({});
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code, trace_id: TRACE });
      await validateResponse(response.json(), 'ErrorEnvelope');
    });
  },
);
