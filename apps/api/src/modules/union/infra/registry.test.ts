import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { CallCtx, UnionEndpoint, UnionMode } from '../domain/types.ts';
import { PddUnionAdapter } from './pdd/pdd-adapter.ts';
import { createUnionRegistry } from './registry.ts';
import type { UnionTransport } from './replay.ts';

const clock = new FixedClock('2026-10-14T08:00:00.000Z');
const ctx: CallCtx = { appId: 'fake-app', requestId: 'fake-request', purpose: 'online' };

function endpoints(pdd: UnionMode): UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => {
    const mode = platform === 'pdd' ? pdd : 'live';
    return {
      platform,
      mode,
      baseUrl: mode === 'demo' ? null : `https://${platform}.invalid/router`,
      quotaKey: `fake:${platform}`,
    };
  });
}

function pddLive() {
  return {
    credentials: vi.fn(async () => ({ clientId: 'FAKE_ID', clientSecret: 'FAKE_SECRET' })),
    transport: vi.fn<UnionTransport>().mockResolvedValue({ status: 200, headers: {}, body: '{}' }),
  };
}

it('[AC-B1-04t-UNIT#4] pddLive + mode=live 直接返回真实 pdd 适配器，其余平台不变', async () => {
  const registry = createUnionRegistry({
    endpoints: endpoints('live'),
    environment: 'staging',
    seed: 'fake',
    clock,
    pddLive: pddLive(),
  });
  expect(registry.get('pdd')).toBeInstanceOf(PddUnionAdapter);
  expect(registry.registrations().map((entry) => entry.implemented)).toEqual([false, true, false]);
  await expect(registry.get('jd').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
    code: 'adapter_unimplemented',
  });
});

it('[AC-B1-04t-UNIT#5] replay 或不传 pddLive 时 pdd 仍未实现，不取凭据', async () => {
  for (const options of [
    { endpoints: endpoints('replay'), pddLive: pddLive() },
    { endpoints: endpoints('live') },
  ]) {
    const registry = createUnionRegistry({
      environment: 'staging',
      seed: 'fake',
      clock,
      ...options,
    });
    expect(registry.get('pdd')).not.toBeInstanceOf(PddUnionAdapter);
    await expect(registry.get('pdd').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
    if ('pddLive' in options) expect(options.pddLive.credentials).not.toHaveBeenCalled();
  }
});
