// B2-04ze: app.module assembles SettlementModule.forWorker on the worker entry only (D10-443), with
// the owners' exports as its ports — above all readAttribution = commission
// readCommissionAttribution (HANDOFF 10-27: without it a commission_version bump rolls whole orders
// back, the v2 snapshot having no writer). The module itself is not built here (the call is
// captured). The owners' barrels are loaded at run time, like app.module, so their Nest classes stay
// out of the spec project's compile.
import { expect, it } from 'vitest';
import { ROOT, capturedPorts } from './kit.ts';

async function load<T>(path: string): Promise<T> {
  return (await import(new URL(path, ROOT).href)) as T;
}

it('[AC-B2-04ze#20] app.module 只在 worker 入口调用 SettlementModule.forWorker（恰 1 次）；api / admin / stream / payout 入口都不调用', async () => {
  const worker = await capturedPorts('worker');
  expect(
    worker,
    'app.module does not assemble SettlementModule.forWorker on the worker entry',
  ).not.toBeNull();
  for (const entry of ['api', 'admin', 'stream', 'payout'] as const) {
    expect(await capturedPorts(entry), entry).toBeNull();
  }
});

it('[AC-B2-04ze#21] worker 入口的端口取自各属主导出：readAttribution 恰为 commission.readCommissionAttribution（必传）；快照、淘礼金、受益人事件取 commission；联盟为准读口、资产快照状态取 ledger；锁用户取 identity.lockUsersForUpdate；平台 = union 已注册平台；其余端口都已给出', async () => {
  const ports = await capturedPorts('worker');
  expect(ports, 'no ports captured on the worker entry').not.toBeNull();
  const commission = await load<Record<string, unknown>>(
    'apps/api/src/modules/commission/index.ts',
  );
  const ledger = await load<Record<string, unknown>>('apps/api/src/modules/ledger/index.ts');
  const identity = await load<Record<string, unknown>>('apps/api/src/modules/identity/index.ts');
  const union = await load<{ REGISTERED_PLATFORMS: readonly string[] }>(
    'apps/api/src/modules/union/index.ts',
  );

  expect(typeof commission['readCommissionAttribution']).toBe('function');
  expect(ports?.readAttribution).toBe(commission['readCommissionAttribution']);
  expect(ports?.readSnapshot).toBe(commission['readCommissionSnapshot']);
  expect(ports?.readTljDeductFen).toBe(commission['readTljDeductFen']);
  expect(ports?.appendBeneficiaryEvent).toBe(commission['appendBeneficiaryEvent']);
  expect(ports?.readUnionAuthoritative).toBe(ledger['readUnionAuthoritativeOrderKeys']);
  expect(ports?.snapshotStatus).toBe(ledger['getAssetSnapshotStatus']);
  expect(ports?.lockUsers).toBe(identity['lockUsersForUpdate']);
  expect([...(ports?.platforms ?? [])].sort()).toStrictEqual(
    [...union.REGISTERED_PLATFORMS].sort(),
  );

  const factories = [
    'registerDiff',
    'readOrderNets',
    'ledger',
    'deletionStatus',
    'realnameStatus',
    'riskState',
    'minors',
    'config',
  ] as const;
  expect(Object.fromEntries(factories.map((name) => [name, typeof ports?.[name]]))).toStrictEqual(
    Object.fromEntries(factories.map((name) => [name, 'function'])),
  );
});
