// B2-09a contract and mounting rule test (claude-independent, SPEC_REF 37808a50): CT-24v's
// listAdminReconDiffs and getAdminReconDiff are implemented — contracts/openapi.yaml and the
// generated planned list no longer mark them planned, x-auth and x-error-codes stay as CT-24v
// fixed them — and the admin entry serves each exactly once with the contract's request schema;
// the api entry serves neither. No database (unit test, no listen).
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { DETAIL_PATH, LIST_PATH, NOW, contractPaths } from './kit.ts';

const ROOT = new URL('../../../../', import.meta.url);

const OPERATIONS = [
  { operationId: 'listAdminReconDiffs', path: LIST_PATH, route: '/admin/v1/recon-diffs' },
  {
    operationId: 'getAdminReconDiff',
    path: DETAIL_PATH,
    route: '/admin/v1/recon-diffs/:recon_diff_id',
  },
] as const;

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

it('[AC-B2-09a#10] listAdminReconDiffs / getAdminReconDiff 去掉 x-implementation: planned（生成的 planned 清单同步），x-auth admin、x-error-codes [10001, 10403, 20001] 不变；admin 入口各挂一次 GET 并带契约请求 schema，api 入口不挂', async () => {
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
