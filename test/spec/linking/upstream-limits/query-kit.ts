import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { LinkingUnionIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { queryPddAuthority } from '../../../../apps/api/src/modules/linking/application/pdd-authority.ts';
import { demo } from '../open-pdd-auth/port-kit.ts';
import { outcome, type Query } from '../open-pdd-auth/kit.ts';

export function queryClient(implementation: Query) {
  const adapter = demo();
  const query = vi.fn(implementation);
  adapter.queryPddAuthority = query;
  const logger = { warn: vi.fn() };
  const identity = new LinkingUnionIdentity({
    appId: 'synthetic_limit',
    platform: 'pdd',
    promotionSlot: 'synthetic-pid',
    userKey: 'pdd0000a',
    customParameters: { app: 'n', uid: 'pdd0000a', sc: 'self_buy' },
  });
  const call = () =>
    outcome(() =>
      queryPddAuthority(
        { registry: { get: () => adapter }, logger },
        { appId: 'synthetic_limit', identity, traceId: randomUUID(), events: 'linking.test' },
      ),
    );
  return { query, logger, call };
}

/** Actual shared query entry, with no database connections held by these occupants. */
export async function occupyQueries(count: number) {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let arrivals = 0;
  const client = queryClient(async () => {
    arrivals += 1;
    if (arrivals === count) entered.resolve();
    await release.promise;
    return { authorized: true };
  });
  const pending = Array.from({ length: count }, () => client.call());
  // An unexpectedly refused occupant resolves this race too, allowing an assertion to fail.
  await Promise.race([entered.promise, ...pending]);
  return {
    client,
    pending,
    async close() {
      release.resolve();
      await Promise.all(pending);
    },
  };
}
