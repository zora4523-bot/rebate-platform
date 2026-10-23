import { expect, it, vi } from 'vitest';
import type { WalletSummaryQuery } from '../../../../apps/api/src/modules/ledger/application/wallet-summary.ts';
import { WalletSummaryController } from '../../../../apps/api/src/modules/ledger/http/public/wallet-summary.controller.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type TokenPrincipal,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { apiRequire, ROOT, validateSummary, ZERO } from './kit.ts';

const PRINCIPAL: TokenPrincipal = {
  uid: '0199a3b4-5c6d-7000-8000-000000000011',
  app_id: 'wallet_a',
  sid: '0199a3b4-5c6d-7000-8000-000000000022',
  device_id: '0199a3b4-5c6d-7000-8000-000000000033',
  scp: 'full',
};

it.each(['full', 'deletion_only'] as const)(
  '[AC-B2-04y#11] AC-S2-33 %s 会话只取认证身份，原样返回查询的全部字段',
  async (scp) => {
    const data = {
      ...ZERO,
      available_fen: -17,
      negative_fen: 17,
      frozen_fen: 29,
      estimated_total_fen: 52,
      estimated_fen: 11,
      pending_credit_fen: 41,
      pending_credit_paused_fen: 19,
      next_credit_period: '2027-02',
      credit_overdue: true,
      withdrawn_fen: 101,
      risk_paused_reason: 'account_frozen',
      withdraw_enabled: false,
    };
    const query = vi.fn<WalletSummaryQuery>().mockResolvedValue(data);
    const controller = new WalletSummaryController(query);
    const request = {
      id: 'wallet-controller',
      principal: { ...PRINCIPAL, scp },
      query: { app_id: 'evil', user_id: 'other', account_type: 'PROMO' },
      body: { app_id: 'evil', user_id: 'other' },
      headers: { 'x-app-id': 'evil', 'x-user-id': 'other' },
      params: { app_id: 'evil', user_id: 'other' },
    };
    const response = await controller.summary(request);
    expect(query).toHaveBeenCalledExactlyOnceWith({
      appId: PRINCIPAL.app_id,
      userId: PRINCIPAL.uid,
    });
    expect(response).toEqual({ code: 0, msg: '', trace_id: request.id, data });
    await validateSummary(response, true);
  },
);

it('[AC-B2-04y#12] 没有认证上下文时拒绝读取，伪造请求身份不能补成登录用户', async () => {
  const query = vi.fn<WalletSummaryQuery>().mockResolvedValue(ZERO);
  const controller = new WalletSummaryController(query);
  const request = {
    id: 'wallet-anonymous',
    query: { app_id: PRINCIPAL.app_id, user_id: PRINCIPAL.uid },
    headers: { 'x-app-id': PRINCIPAL.app_id, 'x-user-id': PRINCIPAL.uid },
  };
  await expect(controller.summary(request)).rejects.toMatchObject({
    status: 401,
    response: { code: 10001, trace_id: request.id },
  });
  expect(query).not.toHaveBeenCalled();
});

it('[AC-B2-04y#13] 查询失败时控制器不得返回成功的空钱包', async () => {
  const failure = new Error('wallet source unavailable');
  const query = vi.fn<WalletSummaryQuery>().mockRejectedValue(failure);
  const controller = new WalletSummaryController(query);
  await expect(controller.summary({ id: 'wallet-failure', principal: PRINCIPAL })).rejects.toBe(
    failure,
  );
  expect(query).toHaveBeenCalledExactlyOnceWith({ appId: PRINCIPAL.app_id, userId: PRINCIPAL.uid });
});

// Nest metadata checks the production controller and entry assembly without opening a port.
// The actual query / response equality is exercised both above and against a real database (#10).
it('[AC-B2-04y#14] 钱包控制器注册 GET /v1/wallet/summary 并装配到 api 入口', async () => {
  apiRequire('reflect-metadata');
  const metadata = Reflect as typeof Reflect & {
    getMetadata(key: string, target: object): unknown;
  };
  const handler = WalletSummaryController.prototype.summary;
  expect(metadata.getMetadata('method', handler)).toBe(0);
  const base = metadata.getMetadata('path', WalletSummaryController);
  const path = metadata.getMetadata('path', handler);
  expect(typeof base).toBe('string');
  expect(typeof path).toBe('string');
  expect(`${String(base)}/${String(path)}`.split('/').filter(Boolean).join('/')).toBe(
    'v1/wallet/summary',
  );

  interface ModuleShape {
    module?: object;
    imports?: unknown[];
    controllers?: unknown[];
  }
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): ModuleShape };
  };
  const root = AppModule.forEntry({
    entry: 'api',
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-23T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }, { write() {} }),
  });
  const controllers = new Set<unknown>();
  const visited = new Set<unknown>();
  function walk(value: unknown): void {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      visited.has(value)
    )
      return;
    visited.add(value);
    const module = value as ModuleShape;
    const target = module.module ?? value;
    const reflectedControllers = metadata.getMetadata('controllers', target);
    const reflectedImports = metadata.getMetadata('imports', target);
    for (const controller of [
      ...(module.controllers ?? []),
      ...(Array.isArray(reflectedControllers) ? reflectedControllers : []),
    ])
      controllers.add(controller);
    for (const child of [
      ...(module.imports ?? []),
      ...(Array.isArray(reflectedImports) ? reflectedImports : []),
    ])
      walk(child);
  }
  walk(root);
  expect(controllers.has(WalletSummaryController)).toBe(true);
});
