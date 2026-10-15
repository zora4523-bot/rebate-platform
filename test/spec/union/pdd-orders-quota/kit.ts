import { vi } from 'vitest';
import {
  FixedClock,
  type QuotaLimiter,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  type UnionAdapter,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { endpoint, row } from '../pdd-orders/kit.ts';

// Synthetic DTO fixtures only; no upstream recordings, network, or wall-clock waits.
export const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          if (signal?.aborted === true) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

export function govern(
  adapter: UnionAdapter,
  take: QuotaLimiter['tryAcquire'],
  timer: Scheduler = scheduler,
) {
  return createGovernedAdapter(adapter, {
    endpoint: { ...endpoint, platform: adapter.platform as typeof endpoint.platform },
    scheduler: timer,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

export function wireSetup(
  reply: (body: Record<string, unknown>, signal?: AbortSignal) => string | Promise<string>,
) {
  const clock = new FixedClock('2026-10-15T00:00:00Z');
  const requests: Record<string, unknown>[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    requests.push(body);
    return { status: 200, headers: {}, body: await reply(body, request.signal) };
  });
  const adapter = new PddUnionAdapter({
    clock,
    endpoint,
    credentials: async () => ({ clientId: 'synthetic-client', clientSecret: 'fake-secret' }),
    transport,
  });
  return { adapter, clock, transport, requests };
}

export function rows(count = 112) {
  return Array.from({ length: count }, (_, i) => row({ order_sn: `quota-order-${i}` }));
}

export function pageReply(body: Record<string, unknown>, data = rows()): string {
  const page = body.page as number;
  return JSON.stringify({
    order_list_get_response: { order_list: data.slice((page - 1) * 50, page * 50) },
  });
}
