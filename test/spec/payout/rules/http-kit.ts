import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { PayoutModule } from '../../../../apps/api/src/modules/payout/payout.module.ts';
import type { WithdrawRulesService } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import * as sessions from '../../../../apps/api/src/modules/identity/infra/session-lookup.ts';
import {
  signScopedToken,
  type TokenKeyProvider,
  type TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  TOKEN_KEYS,
  TOKEN_SERVICE,
} from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { createRootLogger, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { actor, applicationFixture } from './fixtures.ts';

const root = new URL('../../../../', import.meta.url);
interface Response {
  statusCode: number;
  json<T = unknown>(): T;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(options: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<Response>;
  getHttpServer(): { listening: boolean };
  getHttpAdapter(): {
    getInstance(): {
      ready(): Promise<unknown>;
      addHook(
        name: 'onRoute',
        callback: (route: { method: string | string[]; url: string }) => void,
      ): void;
    };
  };
}
export const success = {
  can_withdraw: true,
  block_code: null,
  block_reason: null,
  max_withdrawable_fen: 500000,
  withdrawable_fen: 800000,
  daily_remaining: 1,
  monthly_remaining: 10,
  est_fee_fen: 0,
  est_tax_fen: 0,
  est_net_fen: 500000,
  quick_amounts_fen: [],
};

/** Real bootstrap, token/scope checks, route schemas and global error mapping.
 * Only the payout use case and session/config storage are replaced. No listener or DB. */
export async function httpFixture() {
  const f = applicationFixture();
  const service: WithdrawRulesService = {
    getRules: vi.fn(async () => ({ ...success })),
    validate: vi.fn(async () => null),
  };
  const original = PayoutModule.forRoot;
  vi.spyOn(PayoutModule, 'forRoot').mockImplementation((options) =>
    original({ ...options, rules: service, handle: f.handle }),
  );
  vi.spyOn(sessions, 'createSessionLookup').mockReturnValue({
    find: async () => ({ revoked_at: null }),
  });
  const { RiskModule } = (await import(
    new URL('apps/api/src/modules/risk/risk.module.ts', root).href
  )) as {
    RiskModule: { forRoot(options: Record<string, unknown>): Record<string, unknown> };
  };
  const originalRisk = RiskModule.forRoot;
  const minimum = vi.fn(async () => '99.0.0');
  vi.spyOn(RiskModule, 'forRoot').mockImplementation((options) =>
    originalRisk({
      ...options,
      minimumVersions: {
        useFactory: () => ({
          pooled: { minSupportedVersion: minimum },
          on: () => ({ minSupportedVersion: minimum }),
        }),
      },
    }),
  );
  const overrides = {
    clock: f.clock,
    config: loadConfig({ APP_ENV: 'test' }),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(entry: 'api', options: typeof overrides): Promise<App>;
  };
  const app = await createHttpApp('api', overrides);
  const routes: string[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
    });
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  const principal = {
    uid: actor.userId,
    app_id: actor.appId,
    sid: 'synthetic-session',
    device_id: actor.deviceId,
    scp: 'full' as const,
  };
  const access = await app.get<TokenService>(TOKEN_SERVICE).issueAccess(principal);
  return {
    app,
    service,
    routes,
    minimum,
    handle: f.handle,
    request(
      query = '',
      authorization: string | null = `Bearer ${access}`,
      extra: Record<string, string> = {},
    ) {
      return app.inject({
        method: 'GET',
        url: `/v1/withdrawals/rules${query}`,
        headers: {
          'x-app-id': actor.appId,
          'x-platform': 'ios',
          'x-app-version': '1.0.0',
          'x-channel': 'appstore',
          'x-device-id': actor.deviceId,
          'x-trace-id': '01920000-0000-7000-8000-000000000059',
          ...(authorization === null ? {} : { authorization }),
          ...extra,
        },
      });
    },
    async h5() {
      return `Bearer ${await signScopedToken(app.get<TokenKeyProvider>(TOKEN_KEYS), {
        audience: 'h5',
        claims: { ...principal, scp: 'standard' },
        issuedAt: Math.floor(f.clock.now().getTime() / 1000),
        ttlSeconds: 600,
      })}`;
    },
    close: () => app.close(),
  };
}

interface Contract {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
}
export async function contract() {
  const parser = createRequire(new URL('apps/api/package.json', root))(
    '@readme/openapi-parser',
  ) as { dereference(path: string, options: object): Promise<Contract> };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)), {
    resolve: { external: false },
  });
}
export async function assertContract(response: Response, schemaName: string) {
  const schema = (await contract()).components.schemas[schemaName];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}
