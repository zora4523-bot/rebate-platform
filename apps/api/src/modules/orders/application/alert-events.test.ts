// B1-08u 源码旁单元测试：快照补偿重试耗尽告警 order.snapshot_retry_exhausted 的入队（不连库：trx 只作占位，
// 总线是 mock）。载荷恰 4 个字段、事件 ID 由（事件名、App、载荷）派生；未注入总线不入队；入队抛错原样传出。
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { EventBus } from '../../platform/index.ts';
import { derivedEventId, publishSnapshotRetryExhausted } from './alert-events.ts';
import { snapshotRetryAlert, SNAPSHOT_RETRY_EXHAUSTED } from './snapshot-retry-step.ts';

const trx = { isTransaction: true } as unknown as Transaction<DB>;
const ORDER_ID = '0192f0a4-6d1e-7c3a-8b2f-3e4d5c6b7a81';
const alert = snapshotRetryAlert(
  { app_id: 'app-a', platform: 'jd', sub_order_id: 'SUB-123456789' },
  ORDER_ID,
  {
    id: 42n,
    reason: 'AMOUNT_PARSE_FAILED',
    detected_at: new Date(0),
    created_at: new Date(0),
    resolution_note: null,
  },
);

function bus() {
  const publish = vi
    .fn<EventBus['publish']>()
    .mockResolvedValue({ eventId: 'synthetic', duplicate: false });
  return { publish };
}

it('[AC-B1-08u#U1] 注入总线：同一 trx 入队一次，载荷恰为 order_id / pending_id / platform / reason，事件 ID 派生', async () => {
  const events = bus();
  await publishSnapshotRetryExhausted(events, trx, alert);
  expect(events.publish).toHaveBeenCalledTimes(1);
  const [seenTrx, event] = events.publish.mock.calls[0]!;
  expect(seenTrx).toBe(trx);
  const payload = {
    order_id: ORDER_ID,
    pending_id: '42',
    platform: 'jd',
    reason: 'AMOUNT_PARSE_FAILED',
  };
  expect(event).toStrictEqual({
    appId: 'app-a',
    name: SNAPSHOT_RETRY_EXHAUSTED,
    payload,
    eventId: derivedEventId(SNAPSHOT_RETRY_EXHAUSTED, 'app-a', payload),
  });
  expect(JSON.stringify(event.payload)).not.toContain('SUB-123456789');
});

it('[AC-B1-08u#U2] 同一告警重发得到同一事件 ID（由总线判重复）；载荷不同则事件 ID 不同', async () => {
  const events = bus();
  await publishSnapshotRetryExhausted(events, trx, alert);
  await publishSnapshotRetryExhausted(events, trx, alert);
  await publishSnapshotRetryExhausted(events, trx, { ...alert, pending_id: '43' });
  const ids = events.publish.mock.calls.map(([, event]) => event.eventId);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).not.toBe(ids[0]);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('[AC-B1-08u#U3] 未注入总线不入队、不抛错；入队抛错原样传出（由调用方回滚）', async () => {
  await expect(publishSnapshotRetryExhausted(undefined, trx, alert)).resolves.toBeUndefined();
  const failure = new Error('synthetic enqueue failure');
  const events = { publish: vi.fn<EventBus['publish']>().mockRejectedValue(failure) };
  await expect(publishSnapshotRetryExhausted(events, trx, alert)).rejects.toBe(failure);
  expect(events.publish).toHaveBeenCalledTimes(1);
});
