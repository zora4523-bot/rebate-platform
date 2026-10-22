import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';
import { CONSUMER, failInsert, fixture, job, NOW, openSuite, QUEUE, type Suite } from './db-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it('[AC-B1-12r#20] 真实发布 claim.resolved 路由至唯一 worker 消费者；关闭推送仍发站内信，不入推送短信队列', async () => {
  const f = await fixture(suite);
  await f.item(321n);
  await f.db
    .insertInto('notification_settings')
    .values({
      app_id: f.appId,
      user_id: f.userId,
      service_push: false,
      subscription_push: false,
      marketing_push: false,
    })
    .execute();
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    const send = vi.fn<JobQueue['send']>(
      async (_queue, _name, _payload, options) => options.id ?? null,
    );
    const bus = createEventBus({ queue: { send }, clock: f.clock });
    const event = f.event();
    await f.db.transaction().execute((trx) =>
      bus.publish(trx, {
        appId: event.appId,
        eventId: event.eventId,
        name: event.name,
        payload: event.payload,
      }),
    );
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0]?.slice(0, 3)).toEqual([
      QUEUE,
      'claim.resolved',
      {
        app_id: f.appId,
        v: 1,
        occurred_at: NOW,
        data: event.payload,
      },
    ]);
    const [queue, name, payload, options] = send.mock.calls[0]!;
    for (const attempt of [1, 2]) {
      await matches[0]!.handler({ id: options.id!, queue, name, payload, attempt });
    }
    expect((await f.rows()).inbox).toMatchObject([
      { code: 'CLAIM_RESULT', user_id: f.userId, body: '订单找回成功，预估返 ¥3.21' },
    ]);
    expect((await f.rows()).logs).toMatchObject([
      { channel: 'inbox', status: 'success', dedupe_key: `claim.resolved:${event.eventId}` },
    ]);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select(['event_id', 'consumer'])
        .where('event_id', '=', event.eventId)
        .execute(),
    ).toEqual([{ event_id: event.eventId, consumer: CONSUMER }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each(['cancelled', 'manual_review', 'future_status'])(
  '[AC-B1-12r#21] worker 确认 %s 事件但不发信、不写日志、不排其他渠道',
  async (status) => {
    const f = await fixture(suite);
    const event = f.event({ status });
    const app = await assembled('worker', f.db, f.clock);
    try {
      const matches = app.registrations.filter((r) => r.name === QUEUE);
      expect(matches).toHaveLength(1);
      await matches[0]!.handler(job(event));
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      expect(
        await f.db
          .selectFrom('processed_events')
          .select('event_id')
          .where('consumer', '=', CONSUMER)
          .where('event_id', '=', event.eventId)
          .execute(),
      ).toEqual([{ event_id: event.eventId }]);
      expect(app.sends).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('[AC-B1-12r#22] worker 写入失败时 processed_events 同步回滚，重投成功后仅确认一次', async () => {
  const f = await fixture(suite);
  await f.item(321n);
  const event = f.event();
  const fault = failInsert('notify_logs');
  const app = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await expect(matches[0]!.handler(job(event))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('event_id', '=', event.eventId)
        .execute(),
    ).toEqual([]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
  const recovered = await assembled('worker', f.db, f.clock);
  try {
    const matches = recovered.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job({ ...event, attempt: 2 }));
    expect((await f.rows()).inbox).toHaveLength(1);
    expect((await f.rows()).logs).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', CONSUMER)
        .where('event_id', '=', event.eventId)
        .execute(),
    ).toEqual([{ event_id: event.eventId }]);
    expect(recovered.sends).not.toHaveBeenCalled();
  } finally {
    await recovered.close();
  }
});
