// B1-09i: the worker's real order-sync runtime (OrdersModule.forWorker over the test database) for
// the write-back of manual requests. Only the union adapter, the credential owner lookup and the
// pipeline's per-order outcome are replaced; the registered order-sync handler, union's site
// authorization read, the cursor store and the order_sync_requests writer stay real. Only the
// container runner executes the integration tests that import this file.
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter, UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';
import { order } from '../attribution/kit.ts';
import type { Harness } from '../../admin/auth/kit.ts';

export async function worker(h: Harness, accountId: string) {
  const f = await contextOf('worker', true, h.db);
  const r = await runtime(f.context);
  const handle = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
  expect(typeof handle, 'order-sync handler registered by the worker').toBe('function');
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [], nextCursor: null });
  const getPddOrderDetail = vi.fn<NonNullable<UnionAdapter['getPddOrderDetail']>>();
  const adapter = { listOrders, getPddOrderDetail };
  vi.spyOn(r.registry, 'get').mockReturnValue(adapter);
  expect(typeof r.access.queryableAccount).toBe('function');
  vi.spyOn(r.access, 'queryableAccount').mockResolvedValue(accountId);
  const process = vi.spyOn(r.pipeline, 'process').mockResolvedValue({ kind: 'unchanged' });
  const read = vi.spyOn(r.cursors, 'read');
  const advance = vi.spyOn(r.cursors, 'advance');
  const clock = f.context.get(f.platform.CLOCK) as Clock;
  return {
    ...f,
    r,
    handle: handle!,
    listOrders,
    getPddOrderDetail,
    process,
    read,
    advance,
    clock,
    close: () => f.context.close(),
  };
}
export type Worker = Awaited<ReturnType<typeof worker>>;

/** A normalized Pinduoduo order with its own sub-order number. */
export function unionOrder(patch: Partial<UnionOrder> = {}): UnionOrder {
  const id = randomUUID();
  return order({ order_id: id, sub_order_id: id, ...patch });
}
