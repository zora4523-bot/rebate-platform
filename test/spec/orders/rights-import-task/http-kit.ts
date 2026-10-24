// 不挂载（J-1 / J-22）：真实的后台入口（createHttpApp('admin')，含 multipart 插件与全局错误处理）上临时挂
// 一个探针控制器，把请求原样交给 orders 的 AdminRightsImportsHttp；操作守卫是假的，按
// specs/permissions.yaml 的档位（order.claim 无二次验证，risk.blocklist 为 totp）放行或拒绝。
// 不走全局路由：契约里的 /admin/v1/rights-imports 仍是 planned。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import {
  AdminRightsImportsHttp,
  type RightsImportReadRequest,
  type RightsImportRequest,
} from '../../../../apps/api/src/modules/orders/http/admin/rights-imports.http.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  AdminActor,
  AdminOperationGuard,
  AdminOperationInput,
} from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type { Fixture } from './db-kit.ts';
import { MULTIPART, NOW, multipart, type Part } from './kit.ts';

export const BODY_LIMIT = 1_048_576;
/** The one totp step-up token the fake guard accepts (low-entropy test value). */
export const STEP_UP = 'step-up-plain-plain-plain';
export const BASE = '/__rights_import_probe/imports';

/** specs/permissions.yaml step_up_tier of the two points this route uses. */
const TIERS: Readonly<Record<string, 'totp' | null>> = {
  'order.claim': null,
  'risk.blocklist': 'totp',
};

export interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json(): unknown;
}

interface InjectInput {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  payload?: Buffer | string;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: InjectInput): Promise<Response>;
}

type Constructor = abstract new (...args: never[]) => unknown;
type MethodDecorator = (target: object, key: string, descriptor: PropertyDescriptor) => void;
type ParamDecorator = (target: object, key: string, index: number) => void;
interface NestCommon {
  Controller(prefix: string): (target: Constructor) => void;
  Post(path: string): MethodDecorator;
  Get(path: string): MethodDecorator;
  HttpCode(status: number): MethodDecorator;
  Req(): ParamDecorator;
  Query(): ParamDecorator;
  Param(name: string): ParamDecorator;
  HttpException: new (body: object, status: number) => Error;
}

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));

async function nestCommon(): Promise<NestCommon> {
  return (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as NestCommon;
}

/**
 * The guard: the account holds `held.keys`; a point outside them is 10403; a write under a totp
 * point needs X-Step-Up-Token = STEP_UP, else 10003 (tier totp); then the business callback runs.
 */
function fakeGuard(common: NestCommon, actor: AdminActor) {
  const held: { keys: readonly string[] } = { keys: ['order.claim'] };
  const calls: AdminOperationInput[] = [];
  const run = vi.fn<AdminOperationGuard['run']>(async (input, business) => {
    calls.push(input);
    const request = input.request as {
      id: string;
      headers: Record<string, string | string[] | undefined>;
    };
    const keys = typeof input.permission === 'string' ? [input.permission] : [...input.permission];
    if (!keys.some((key) => held.keys.includes(key))) {
      throw new common.HttpException(
        {
          code: 10403,
          msg: '当前账号没有这项操作的权限，请联系超级管理员开通',
          data: { reason: 'admin_permission_denied' },
          trace_id: request.id,
        },
        403,
      );
    }
    const totp = keys.some((key) => TIERS[key] === 'totp');
    if (input.readOnly !== true && totp && request.headers['x-step-up-token'] !== STEP_UP) {
      throw new common.HttpException(
        {
          code: 10003,
          msg: '这项操作需要二次验证，请输入动态码',
          data: { tier: 'totp' },
          trace_id: request.id,
        },
        403,
      );
    }
    return business(actor);
  });
  return { guard: { run }, held, calls };
}

export function post(parts: readonly Part[], headers: Record<string, string> = {}): InjectInput {
  return {
    method: 'POST',
    url: BASE,
    headers: { 'content-type': MULTIPART, ...headers },
    payload: multipart(parts),
  };
}

export type Probe = Awaited<ReturnType<typeof probeParts>>;

async function probeParts(f: Fixture) {
  const common = await nestCommon();
  const actor: AdminActor = {
    adminId: f.adminId,
    appId: f.appId,
    isSuper: false,
    loginName: 'ri_probe_login',
  };
  const guard = fakeGuard(common, actor);
  return { common, actor, guard };
}

/**
 * Boots the admin entry with the probe controller (POST / GET BASE, GET BASE/:import_id) over a
 * fresh AdminRightsImportsHttp built on the fixture's use case deps, runs `check`, closes the app.
 */
export async function withProbe(
  f: Fixture,
  check: (app: HttpApp, probe: Probe) => Promise<void>,
): Promise<void> {
  const probe = await probeParts(f);
  const http = new AdminRightsImportsHttp({ guard: probe.guard.guard, imports: f.deps });
  class RightsImportProbe {
    create(req: RightsImportRequest) {
      return http.create(req);
    }
    list(req: RightsImportReadRequest, query: Record<string, string | undefined>) {
      return http.list(req, {
        page: Number(query['page'] ?? '1'),
        page_size: Number(query['page_size'] ?? '20'),
      });
    }
    detail(req: RightsImportReadRequest, importId: string) {
      return http.detail(req, importId);
    }
  }
  const { common } = probe;
  const prototype = RightsImportProbe.prototype;
  const descriptor = (name: 'create' | 'list' | 'detail') => {
    const found = Object.getOwnPropertyDescriptor(prototype, name);
    if (found === undefined) throw new Error(`probe method ${name} is missing`);
    return found;
  };
  const create = descriptor('create');
  common.Req()(prototype, 'create', 0);
  common.Post('imports')(prototype, 'create', create);
  common.HttpCode(200)(prototype, 'create', create);
  const list = descriptor('list');
  common.Req()(prototype, 'list', 0);
  common.Query()(prototype, 'list', 1);
  common.Get('imports')(prototype, 'list', list);
  common.HttpCode(200)(prototype, 'list', list);
  const detail = descriptor('detail');
  common.Req()(prototype, 'detail', 0);
  common.Param('import_id')(prototype, 'detail', 1);
  common.Get('imports/:import_id')(prototype, 'detail', detail);
  common.HttpCode(200)(prototype, 'detail', detail);
  common.Controller('__rights_import_probe')(RightsImportProbe);

  // Computed imports keep decorated Nest sources outside test/tsconfig's erasable-only build.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: unknown): Record<string, unknown> } };
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: 'admin', overrides: object): Promise<HttpApp> };
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [...((module['controllers'] ?? []) as unknown[]), RightsImportProbe],
    };
  });
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock(NOW),
      logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
    });
    await app.init();
    await check(app, probe);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}
