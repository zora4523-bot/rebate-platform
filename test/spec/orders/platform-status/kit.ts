import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { OrderUpdateDeps } from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { capture, fixture, snapshot, traceQueries } from '../attribution/kit.ts';

export { at, capture, RECEIVED, SETTLED, snapshot } from '../attribution/kit.ts';

export async function scenario(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
  options: { unattributed?: boolean; regressionHold?: (platform: string) => boolean } = {},
) {
  const traced = traceQueries(db);
  const f = await fixture(traced.db, patch);
  if (options.unattributed) f.findUser.mockResolvedValue(null);
  const imported = await createOrderPipeline(f.deps).process(f.incoming, f.ctx);
  expect(imported.kind).toBe('inserted');
  const before = await snapshot(db, f.ctx.app_id);
  const original = before.orders[0];
  expect(original).toBeDefined();
  if (!original) throw new Error('fixture order missing');
  f.clock.advanceMs(60_000);
  f.findUser.mockClear();
  f.findBindings.mockClear();
  f.logger.warn.mockClear();
  f.logger.error.mockClear();
  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>().mockResolvedValue(undefined);
  const onUnmappedStatus = vi
    .fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>()
    .mockResolvedValue(undefined);
  const publish = vi
    .fn<OrderUpdateDeps['events']['publish']>()
    .mockResolvedValue({ eventId: randomUUID(), duplicate: false });
  const deps: OrderUpdateDeps = {
    clock: f.clock,
    users: f.deps.users,
    bindings: f.deps.bindings,
    statusMaps: f.deps.statusMaps,
    rebate: { onUpdated, onUnmappedStatus },
    events: { publish },
    logger: f.logger,
    ...(options.regressionHold ? { regressionHold: options.regressionHold } : {}),
  };
  // Factory must succeed before any expected-rejection assertion is installed.
  const made = await capture(() => createOrderUpdateStep(deps));
  expect(made).toMatchObject({ ok: true });
  if (!made.ok) throw made.error;
  const step = made.value;
  const pipeline = createOrderPipeline({ ...f.deps, updateStep: step });
  traced.queries.length = 0;
  const next = (change: Partial<UnionOrder> = {}): UnionOrder => {
    const platformClock = new FixedClock(f.clock.now().toISOString());
    platformClock.advanceMs(-11_000);
    return {
      ...f.incoming,
      modified_at: platformClock.now(),
      raw_payload_id: '202',
      ...change,
    };
  };
  return {
    ...f,
    before,
    original,
    step,
    updateDeps: deps,
    pipeline,
    next,
    onUpdated,
    onUnmappedStatus,
    publish,
    queries: traced.queries,
    read: () => snapshot(db, f.ctx.app_id),
  };
}

export function historySteps(history: Awaited<ReturnType<typeof snapshot>>['history']) {
  return history.map(({ from_status, event, to_status }) => ({ from_status, event, to_status }));
}

export function expectSafeLogs(f: Awaited<ReturnType<typeof scenario>>) {
  const logs = [...f.logger.warn.mock.calls, ...f.logger.error.mock.calls];
  expect(logs.length).toBeGreaterThan(0);
  for (const args of logs) {
    const fields = args[0] as Record<string, unknown>;
    expect(Object.values(fields).every((v) => v === null || typeof v !== 'object')).toBe(true);
    const text = JSON.stringify(args);
    expect(text).not.toContain(f.incoming.sub_order_id);
    expect(text).not.toContain('abcd1234');
    for (const key of ['pid', 'relation_id', 'sub_union_id', 'custom_params', 'sub_order_id']) {
      expect(fields).not.toHaveProperty(key);
    }
  }
}
