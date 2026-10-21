import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import type {
  DomainEvent,
  EventBus,
  JobQueue,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { derivedEventId } from '../../../../apps/api/src/modules/orders/application/alert-events.ts';
import { handleSnapshotRetry } from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';
import { setup, setupScan, type Fixture } from '../snapshot-retry/kit.ts';

export { capture, HOUR, succeed, splits } from '../snapshot-retry/kit.ts';
export const ALERT = 'order.snapshot_retry_exhausted';
// 沿用 B1-08t 的转人工标记；不从实现常量推导期望值。
export const HANDOFF = 'auto: commission snapshot retry exhausted; manual';

export async function fixture(db: Kysely<DB>, path: 'pipeline' | 'scan' = 'scan') {
  const f = await (path === 'pipeline' ? setup(db) : setupScan(db));
  // 结构扩展：现有入口足够写先红测试，无需改已有实现或增加可执行骨架。
  const deps = { ...f.retryDeps, events: { publish: f.publish } };
  return {
    ...f,
    scan: () => handleSnapshotRetry(f.job, deps),
    legacyScan: f.scan,
    events: () => f.publish.mock.calls.filter(([, event]) => event.name === ALERT),
  };
}

export type AlertFixture = Awaited<ReturnType<typeof fixture>>;
export type Pending = Awaited<ReturnType<Fixture['pending']>>[number];

export function expectedEvent(f: Fixture, pending: Pending): DomainEvent {
  const payload = {
    order_id: f.current.order_id,
    pending_id: pending.id.toString(10),
    platform: f.incoming.platform,
    reason: pending.reason,
  };
  return {
    appId: f.ctx.app_id,
    name: ALERT,
    payload,
    eventId: derivedEventId(ALERT, f.ctx.app_id, payload),
  };
}

export function assertAlert(f: AlertFixture, pending: Pending) {
  const calls = f.events();
  expect(calls).toHaveLength(1);
  const [trx, event] = calls[0]!;
  expect(trx.isTransaction).toBe(true);
  expect(event).toEqual(expectedEvent(f, pending));
  expect(Object.keys(event.payload).sort()).toEqual([
    'order_id',
    'pending_id',
    'platform',
    'reason',
  ]);
  expect(event.payload.pending_id).toMatch(/^[1-9][0-9]*$/);
  const json = JSON.stringify(event.payload);
  expect(json).not.toContain(f.incoming.sub_order_id);
  expect(json).not.toContain(f.userId);
  expect(json).not.toContain('custom_parameters');
  return { trx, event };
}

export function eventRows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', appId)
    .where('name', '=', ALERT)
    .execute();
}

export function realBus(f: Fixture) {
  const send = vi.fn<JobQueue['send']>().mockResolvedValue(null);
  // 本任务不新增消费者；使用真实 EventBus 的校验、幂等和 event_log 事务写入。
  const bus = createEventBus({ queue: { send }, clock: f.clock, subscriptions: [] });
  return { bus, send };
}

export function observePublication(f: AlertFixture, db: Kysely<DB>, bus?: EventBus) {
  const seen: {
    trx: Transaction<DB>;
    inside: Pending[];
    outside: Pending[];
    insideEvents: number;
    outsideEvents: number;
  }[] = [];
  f.publish.mockImplementation(async (trx, event) => {
    const result =
      bus === undefined
        ? { eventId: event.eventId ?? 'synthetic', duplicate: false }
        : await bus.publish(trx, event);
    if (event.name === ALERT) {
      seen.push({
        trx,
        inside: await trx
          .withSchema('app')
          .selectFrom('order_sync_pending')
          .selectAll()
          .where('app_id', '=', f.ctx.app_id)
          .orderBy('id')
          .execute(),
        outside: await f.pending(),
        insideEvents: (await eventRows(trx, f.ctx.app_id)).length,
        outsideEvents: (await eventRows(db, f.ctx.app_id)).length,
      });
    }
    return result;
  });
  return seen;
}

// 否定场景配真实可告警的对照，防止完全不接事件的旧实现让本任务用例变绿。
export async function positiveControl(db: Kysely<DB>) {
  const f = await fixture(db);
  const pending = (await f.pending())[0]!;
  f.clock.advanceMs(24 * 3_600_000);
  await f.scan();
  assertAlert(f, pending);
}
