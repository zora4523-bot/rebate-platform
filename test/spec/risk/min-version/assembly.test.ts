import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  loadConfig,
  createRootLogger,
  type DbHandles,
  type PlatformOptions,
  IDEMPOTENCY,
  type Idempotency,
  type RequestCheck,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createTokenCheck,
  TokenRejection,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  RiskModule,
  SIGNATURE_CHECK,
  createSignatureCheck,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { dependencies, input as signedInput } from '../signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { HEADERS, PRINCIPAL, ROOT, TRACE, apiRequire } from './kit.ts';
import { RESULT, STORED, idemFixture, idemRequest } from './idempotency-kit.ts';

type Constructor = abstract new (...args: never[]) => unknown;
interface HttpApp {
  get(token: symbol): Idempotency;
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(options: object): Promise<{ statusCode: number; body: string }>;
}

it('[AC-B1-03c#21] markTipRead：真实 AppModule 自动装配 content 读取器和 ④a guard；③ 优先，10405 保留契约 data', async () => {
  // Only add a controller for a planned contract route. No test-installed version guard,
  // no ④a provider replacement: removing production assembly must make this test fail.
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    Controller(path: string): (target: Constructor) => void;
    Post(path: string): (target: object, key: string, descriptor: PropertyDescriptor) => void;
  };
  const handled = vi.fn(() => ({ code: 0, msg: '', trace_id: TRACE }));
  // 此 planned 路由实现时须换为其他 planned 路由，或改为替换真实控制器的服务依赖。
  class Probe {
    markTipRead() {
      return handled();
    }
  }
  common.Controller('v1')(Probe);
  common.Post('me/tips/:tip_key/read')(
    Probe.prototype,
    'markTipRead',
    Object.getOwnPropertyDescriptor(Probe.prototype, 'markTipRead')!,
  );
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: PlatformOptions): Record<string, unknown> };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      overrides: {
        dbHandles: DbHandles;
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: ReturnType<typeof createRootLogger>;
      },
    ): Promise<HttpApp>;
  };
  const { TOKEN_CHECK } = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as { TOKEN_CHECK: symbol };
  // markTipRead requires login: keep real ②/③ checks with in-memory token/session ports.
  const tokenCheck = createTokenCheck({
    tokens: {
      verifyAccess: async (token) => {
        if (token !== 'assembly-fixture') throw new TokenRejection(10002);
        return PRINCIPAL;
      },
      issueAccess: async () => {
        throw new Error('unexpected token issuance');
      },
      issueRefresh: () => {
        throw new Error('unexpected token issuance');
      },
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [...((module['controllers'] ?? []) as unknown[]), Probe],
      providers: [
        ...((module['providers'] ?? []) as unknown[]),
        { provide: TOKEN_CHECK, useValue: tokenCheck },
      ],
    };
  });
  const f = idemFixture(idemRequest(false), 'missing', true, '8.4.2');
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2031-01-01T00:00:00Z'),
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    });
    await app.init();
    const options = {
      method: 'POST',
      url: '/v1/me/tips/jump_tip/read',
      headers: { ...HEADERS, 'x-trace-id': TRACE, authorization: 'Bearer assembly-fixture' },
      payload: { platform: 'taobao' },
    };
    const invalidToken = await app.inject({
      ...options,
      headers: { ...options.headers, authorization: 'Bearer invalid' },
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(JSON.parse(invalidToken.body)).toMatchObject({ code: 10002 });
    expect(f.events).not.toContain('minimum-read');
    const result = await app.inject(options);
    expect(result.statusCode).toBe(403);
    const body: unknown = JSON.parse(result.body);
    expect(body).toEqual({
      code: 10405,
      msg: expect.any(String),
      data: { min_supported_version: '8.4.2' },
      trace_id: TRACE,
    });
    const validate = await envelopeValidator();
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(handled).not.toHaveBeenCalled();
    expect(f.statements.some((sql) => sql.includes('app_versions'))).toBe(true);
    // gate=true has no withdrawal exemption; a supported full-session client is allowed.
    const supported = await app.inject({
      ...options,
      headers: { ...options.headers, 'x-app-version': '8.4.2' },
    });
    expect(JSON.parse(supported.body)).toMatchObject({ code: 0 });
    expect(handled).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await app?.close();
    await f.db.destroy();
  }
});

for (const transactional of [false, true]) {
  for (const scope of ['full', 'deletion_only'] as const) {
    it(`[AC-B1-03c#22] submitAppeal：AppModule 的 ${transactional ? 'executeInTransaction' : 'execute'} ${scope} 接上线：回放先于 ④a，未命中 10405`, async () => {
      const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
        Controller(path: string): (target: Constructor) => void;
        Post(path: string): (target: object, key: string, descriptor: PropertyDescriptor) => void;
      };
      const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
        AppModule: { forEntry(options: PlatformOptions): Record<string, unknown> };
      };
      const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
        createHttpApp(entry: 'api', overrides: object): Promise<HttpApp>;
      };
      const { TOKEN_CHECK } = (await import(
        new URL('apps/api/src/modules/identity/index.ts', ROOT).href
      )) as {
        TOKEN_CHECK: symbol;
      };
      // Use the real, bootstrap-recognised stage ②/③ check with in-memory token/session ports.
      // Only TOKEN_CHECK is overridden; the production ④a guard and hook stay assembled as-is.
      // A current client isolates deletion_only: a version-only hook must fail this test.
      for (const state of ['completed', 'missing'] as const) {
        const req = {
          ...idemRequest(false),
          path: '/v1/me/appeals',
          body: { target_type: 'account', content: '请核查账号状态。' },
        };
        const f = idemFixture(req, state, true, '8.4.2');
        const deps = dependencies();
        const signature = createSignatureCheck(deps);
        const verifyAccess = vi.fn(async () => ({ ...PRINCIPAL, scp: scope }));
        const tokenCheck: RequestCheck = createTokenCheck({
          tokens: {
            verifyAccess,
            issueAccess: async () => {
              throw new Error('unexpected token issuance');
            },
            issueRefresh: () => {
              throw new Error('unexpected token issuance');
            },
          },
          sessions: { find: async () => ({ revoked_at: null }) },
        });
        const handled = vi.fn(async () => RESULT);
        let idem: Idempotency;
        // B1-03i 起 submitAppeal 有真实控制器（risk 的 AppealsController）：下面 RiskModule.forRoot 的替换
        // 把它去掉，由本探针独占该路由（B1-03r）；其余装配照旧是生产代码。
        class Probe {
          async submitAppeal() {
            const result = transactional
              ? await idem.executeInTransaction(req, handled)
              : await idem.execute(req, handled);
            return JSON.parse(result.body) as unknown;
          }
        }
        common.Controller('v1/me')(Probe);
        common.Post('appeals')(
          Probe.prototype,
          'submitAppeal',
          Object.getOwnPropertyDescriptor(Probe.prototype, 'submitAppeal')!,
        );
        const originalRoot = AppModule.forEntry.bind(AppModule);
        const rootSpy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
          const module = originalRoot(options);
          return {
            ...module,
            controllers: [...((module['controllers'] ?? []) as unknown[]), Probe],
            providers: [
              ...((module['providers'] ?? []) as unknown[]),
              { provide: TOKEN_CHECK, useValue: tokenCheck },
            ],
          };
        });
        // Real stage ① with in-memory device/nonce ports. Do not install or replace stage ④a.
        const originalRisk = RiskModule.forRoot.bind(RiskModule);
        const signatureSpy = vi.spyOn(RiskModule, 'forRoot').mockImplementationOnce((options) => {
          const module = originalRisk(options);
          return {
            ...module,
            controllers: (module.controllers ?? []).filter(
              (controller) => (controller as { name?: string }).name !== 'AppealsController',
            ),
            providers: [
              ...(module.providers ?? []),
              { provide: SIGNATURE_CHECK, useValue: signature },
            ],
          };
        });
        let app: HttpApp | undefined;
        try {
          app = await createHttpApp('api', {
            dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
            config: loadConfig({ APP_ENV: 'test' }),
            clock: deps.clock,
            logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
          });
          await app.init();
          idem = app.get(IDEMPOTENCY);
          const signed = signedInput({
            url: req.path,
            rawBody: Buffer.from(JSON.stringify(req.body)),
          });
          const result = await app.inject({
            method: 'POST',
            url: req.path,
            payload: signed.rawBody,
            headers: {
              ...signed.headers,
              'x-app-version': scope === 'deletion_only' ? '99.0.0' : '0.0.0',
              authorization: 'Bearer assembly-fixture',
              'x-channel': 'app_store',
              'idempotency-key': req.key,
              'x-trace-id': TRACE,
            },
          });
          expect(verifyAccess).toHaveBeenCalledExactlyOnceWith('assembly-fixture');
          if (state === 'completed') {
            expect(result.statusCode).toBe(201);
            expect(result.body).toBe(STORED);
            expect(f.events).not.toContain('minimum-read');
          } else {
            expect(result.statusCode).toBe(403);
            expect(JSON.parse(result.body)).toEqual({
              code: 10405,
              msg: expect.any(String),
              data: { min_supported_version: '8.4.2' },
              trace_id: TRACE,
            });
            expect(f.events).toEqual(['lookup', 'minimum-read']);
            expect(f.statements.filter((sql) => /^(insert|update|delete)\b/i.test(sql))).toEqual(
              [],
            );
          }
          expect(handled).not.toHaveBeenCalled();
        } finally {
          rootSpy.mockRestore();
          signatureSpy.mockRestore();
          await app?.close();
          await f.db.destroy();
        }
      }
    }, 30_000);
  }
}
