// B2-15o contract and mounting rule test (claude-independent, SPEC_REF 9ab94dc0): listAdminPayRefunds
// and getAdminPayRefund are implemented — contracts/openapi.yaml and the generated planned list no
// longer mark them planned, x-auth and x-error-codes stay as the contract fixed them — and the admin
// entry serves each exactly once with the contract's request schema; the api entry serves neither.
// No database (unit test, no listen).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
const NOW = '2026-10-30T02:00:00.000Z';

const OPERATIONS = [
  {
    operationId: 'listAdminPayRefunds',
    path: '/admin/v1/pay-refunds',
    route: '/admin/v1/pay-refunds',
  },
  {
    operationId: 'getAdminPayRefund',
    path: '/admin/v1/pay-refunds/{pay_refund_id}',
    route: '/admin/v1/pay-refunds/:pay_refund_id',
  },
] as const;

interface ContractOperation {
  readonly operationId?: string;
  readonly 'x-implementation'?: string;
  readonly 'x-auth'?: string;
  readonly 'x-error-codes'?: readonly number[];
}

type ContractPaths = Record<string, Record<string, ContractOperation>>;

/** The dereferenced paths of contracts/openapi.yaml. */
async function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    { resolve: { external: false } },
  );
  return document.paths;
}

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: { params?: unknown; querystring?: unknown };
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
      hasRoute(options: { method: 'GET'; url: string }): boolean;
    };
  };
}

async function boot(entry: 'admin' | 'api') {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  const seen = new Map(OPERATIONS.map((op): [string, RouteOptions[]] => [op.route, []]));
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if ([route.method].flat().includes('GET')) seen.get(route.url)?.push(route);
    });
  await app.init();
  return { app, seen };
}

it('[AC-B2-15o#13] listAdminPayRefunds / getAdminPayRefund 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-error-codes [10001, 10403, 20001] 不变；admin 入口各挂一次 GET 并带契约请求 schema，api 入口不挂', async () => {
  const paths = await contractPaths();
  for (const spec of OPERATIONS) {
    const op = paths[spec.path]?.['get'];
    expect(op?.operationId, spec.path).toBe(spec.operationId);
    expect(op?.['x-implementation'], spec.operationId).not.toBe('planned');
    expect(op?.['x-auth'], spec.operationId).toBe('admin');
    const codes = [...(op?.['x-error-codes'] ?? [])].sort((a, b) => a - b);
    expect(codes, spec.operationId).toEqual([10001, 10403, 20001]);
    expect(plannedOperations.has(spec.operationId), spec.operationId).toBe(false);
  }

  const admin = await boot('admin');
  try {
    for (const spec of OPERATIONS) {
      const routes = admin.seen.get(spec.route) ?? [];
      expect(routes, `admin 入口必须恰好挂一次 GET ${spec.route}`).toHaveLength(1);
      const expected = routeSchemaOf(paths[spec.path]!['get'] as never);
      expect(routes[0]!.schema?.querystring, spec.route).toEqual(expected.querystring);
      expect(routes[0]!.schema?.params, spec.route).toEqual(expected.params);
    }
  } finally {
    await admin.app.close();
  }
  const api = await boot('api');
  try {
    for (const spec of OPERATIONS) {
      expect(api.seen.get(spec.route), spec.route).toEqual([]);
      const server = api.app.getHttpAdapter().getInstance();
      expect(server.hasRoute({ method: 'GET', url: spec.route }), spec.route).toBe(false);
    }
  } finally {
    await api.app.close();
  }
});
