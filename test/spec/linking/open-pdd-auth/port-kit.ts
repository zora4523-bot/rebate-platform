import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  UnionIdentity,
  type CallCtx,
  type IdentityClaims,
  type RegisteredPlatform,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { Query } from './kit.ts';

export const ctx: CallCtx = {
  appId: 'synthetic_pdd_port',
  requestId: '0199a3b4-5c6d-7000-8000-000000000006',
  purpose: 'online',
};

export class TestIdentity extends UnionIdentity {
  readonly custom_parameters = { app: 'n', uid: 'pdd0000a', sc: 'self_buy' } as const;
  constructor(claims: Partial<IdentityClaims> = {}) {
    super({
      appId: ctx.appId,
      userId: 'pdd0000a',
      platform: 'pdd',
      promotionSlot: 'synthetic-self_buy',
      relationId: null,
      ...claims,
    });
  }
}

export function demo(platform: RegisteredPlatform = 'pdd') {
  return new DemoUnionAdapter({
    platform,
    seed: 'pdd-port-fixture',
    clock: new FixedClock('2026-10-08T04:05:06.789Z'),
    environment: 'test',
  });
}

/** The optional port is not yet in the frozen interface: absence is an assertion, never TypeError. */
export function queryOf(port: object): Query {
  const method: unknown = Reflect.get(port, 'queryPddAuthority');
  expect(method, 'queryPddAuthority must be implemented at this boundary').toBeTypeOf('function');
  return (method as Query).bind(port);
}
