import { expect, it, vi } from 'vitest';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import { ctx, envelope, identity, read, row, setup, shortLink, sources } from '../pdd-goods/kit.ts';
import { registryOptions } from '../pdd-live-wiring/kit.ts';
import { APP, OTHER_APP, outcome } from './kit.ts';

for (const assembly of ['adapter', 'registry'] as const) {
  it.each([...sources, 'link'] as const)(
    `[AC-B1-04x-CTX#1] ${assembly}/%s 每次向查询身份提供者传当前 CallCtx，两个 app 不串用`,
    async (port) => {
      const fixture = setup((body) => envelope(body.type, [row()]));
      // Optional parameter deliberately compiles against both the old zero-arg port and the new port.
      // Returning a valid fallback allows the old implementation to reach an ordinary assertion.
      const queryIdentity = vi.fn(async (context?: CallCtx) => ({
        ...identity,
        pid: context?.appId === OTHER_APP ? 'synthetic-b-pid' : identity.pid,
      }));
      const live = {
        credentials: fixture.credentials,
        transport: fixture.transport,
        queryIdentity,
      };
      const options = registryOptions();
      const adapter =
        assembly === 'registry'
          ? (createUnionRegistry({ ...options, pddLive: live }).get('pdd') as PddUnionAdapter)
          : new PddUnionAdapter({ ...live, clock: fixture.clock, endpoint: options.endpoints[1]! });
      for (const appId of [APP, OTHER_APP]) {
        const context: CallCtx = {
          ...ctx,
          appId,
          headers: { pid: 'forged-pid', custom_parameters: '{"uid":"forged-user"}' },
        };
        const result = await outcome(() =>
          port === 'link' ? adapter.resolveLink(shortLink, context) : read(adapter, port, context),
        );
        expect(result).not.toBeInstanceOf(Error);
        expect(queryIdentity).toHaveBeenLastCalledWith(context);
        expect(fixture.requests.at(-1)).toMatchObject({
          pid: appId === OTHER_APP ? 'synthetic-b-pid' : identity.pid,
          custom_parameters: identity.customParameters,
        });
        expect(JSON.stringify(fixture.requests)).not.toContain('forged-user');
      }
      expect(queryIdentity).toHaveBeenCalledTimes(2);
    },
  );
}
