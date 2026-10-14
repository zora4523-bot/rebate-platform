import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import {
  LinkConvertService,
  type LinkConvertInput,
} from '../../../../apps/api/src/modules/linking/application/link-convert.ts';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  createRootLogger,
  loadConfig,
  isContractSignedRoute,
  type HandlerResult,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';

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
type Send = (body: object, headers?: Record<string, string | undefined>) => Promise<Response>;
const root = new URL('../../../../', import.meta.url);
export const body = { platform: 'jd', product_key: 'jd:i_12345', scene: 'h5' };
export const traceId = '0199a3b4-5c6d-7000-8000-000000000096';
export const data = {
  link_id: '0199a3b4-5c6d-7000-8000-000000000097',
  attempt_id: '0199a3b4-5c6d-7000-8000-000000000098',
  jump: {
    primary: { type: 'h5', value: 'https://example.test/converted' },
    fallbacks: [],
    expire_at: '2031-05-06T07:18:09.000Z',
  },
  price_changed: false,
  old_final_price_fen: 2990,
  new_final_price_fen: 2990,
  new_link_id: null,
  requote_failed: false,
  new_rebate_min_fen: 229,
  new_rebate_max_fen: 229,
  availability: 'ok',
  quoted_at: '2031-05-06T07:08:09.000Z',
};

/** Real bootstrap, contract validation, signature and token checks; only dependency ports replaced. */
export async function withHttp(
  check: (
    send: Send,
    convert: ReturnType<typeof vi.fn<(input: LinkConvertInput) => Promise<HandlerResult>>>,
  ) => Promise<void>,
) {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', root).href)) as {
    AppModule: { forEntry(options: unknown): ModuleShape };
  };
  const { LinkingModule } = (await import(
    new URL('apps/api/src/modules/linking/linking.module.ts', root).href
  )) as {
    LinkingModule: { forRoot(options: unknown): ModuleShape };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
      },
    ): Promise<HttpApp>;
  };
  const clock = new FixedClock('2031-05-06T07:08:09.000Z');
  const signingMaterial = randomBytes(32).toString('hex');
  const deviceId = randomUUID();
  const principal = {
    uid: randomUUID(),
    app_id: 'couli',
    sid: randomUUID(),
    device_id: deviceId,
    scp: 'full' as const,
  };
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
  const tokenCheck = createTokenCheck({
    tokens: {
      verifyAccess: async () => principal,
      issueAccess: async () => 'synthetic-access',
      issueRefresh: () => ({
        token: 'synthetic-refresh',
        hash: 'synthetic-hash',
        expireAt: clock.now(),
      }),
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const convert = vi.fn<(input: LinkConvertInput) => Promise<HandlerResult>>(async () => ({
    status: 200,
    envelope: { code: 0, msg: 'ok', trace_id: traceId, data },
  }));
  const originalRoot = AppModule.forEntry.bind(AppModule);
  const originalLinking = LinkingModule.forRoot.bind(LinkingModule);
  const linkSpy = vi.spyOn(LinkingModule, 'forRoot').mockImplementation((options) => {
    const module = originalLinking(options);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        { provide: LinkConvertService, useValue: { convert } },
      ],
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
    const send: Send = async (input, overrides = {}) => {
      const payload = JSON.stringify(input);
      const path = '/v1/links/convert';
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
        'x-platform': 'ios',
        'x-app-version': '1.0.0',
        'x-device-id': deviceId,
        'x-channel': 'appstore',
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign,
        'x-trace-id': traceId,
        'idempotency-key': 'synthetic-http-convert',
        authorization: 'Bearer synthetic-access',
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete headers[name];
        else headers[name] = value;
      }
      return server.inject({ method: 'POST', url: path, payload, headers });
    };
    // Each case proves the implemented route exists before testing rejection paths.
    const ready = await send(body);
    expect(ready.statusCode).toBe(200);
    expect(convert).toHaveBeenCalledTimes(1);
    convert.mockClear();
    await check(send, convert);
  } finally {
    rootSpy.mockRestore();
    linkSpy.mockRestore();
    await app?.close();
  }
}
