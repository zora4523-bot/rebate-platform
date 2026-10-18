import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { failInsert, fixture, openSuite, type Suite } from './db-kit.ts';
import { CONSUMER, NOW, QUEUE } from './fixtures.ts';
import { assembled } from './worker-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
});
afterAll(async () => {
  await suite?.close();
});

function job(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}

it('[AC-B1-12g#24] 实际注册的队列 handler 消费事件并完成通知，两次投递成功且无推送短信任务', async () => {
  const f = await fixture(suite);
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    const handler = matches[0]!.handler;
    const received = f.event({ frozen_until: '2026-11-29T16:00:00.000Z' });
    await handler(job(received));
    await handler(job({ ...received, attempt: 2 }));
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      {
        app_id: f.appId,
        user_id: f.userId,
        code: 'RISK_STATE_CHANGED',
        title: '账户通知',
        route: null,
        body: '你的账户提现已暂停至 11-30 00:00，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
      },
    ]);
    expect(rows.logs).toMatchObject([
      {
        channel: 'inbox',
        status: 'success',
        dedupe_key: `risk.state_changed:${received.eventId}`,
        planned_at: new Date(NOW),
        sent_at: new Date(NOW),
      },
    ]);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select(['consumer', 'event_id'])
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ consumer: CONSUMER, event_id: received.eventId }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12g#25] notify_logs 已存在但 processed_events 未写时，真实消费者确认成功且不补发', async () => {
  const f = await fixture(suite);
  const received = f.event();
  await f.log(received);
  const before = await f.rows();
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(received));
    expect(await f.rows()).toEqual(before);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', CONSUMER)
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ event_id: received.eventId }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12g#26] 消费写入失败时 processed_events 与两张通知表一起回滚，队列重投仍能成功', async () => {
  const f = await fixture(suite);
  const received = f.event();
  const fault = failInsert('notify_logs');
  const failedApp = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const matches = failedApp.registrations.filter((registration) => registration.name === QUEUE);
    expect(matches).toHaveLength(1);
    await expect(matches[0]!.handler(job(received))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([]);
    expect(failedApp.sends).not.toHaveBeenCalled();
  } finally {
    await failedApp.close();
  }
  const recoveredApp = await assembled('worker', f.db, f.clock);
  try {
    const matches = recoveredApp.registrations.filter(
      (registration) => registration.name === QUEUE,
    );
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job({ ...received, attempt: 2 }));
    const rows = await f.rows();
    expect(rows.inbox).toHaveLength(1);
    expect(rows.logs).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('processed_events')
        .select('event_id')
        .where('consumer', '=', CONSUMER)
        .where('event_id', '=', received.eventId)
        .execute(),
    ).toEqual([{ event_id: received.eventId }]);
    expect(recoveredApp.sends).not.toHaveBeenCalled();
  } finally {
    await recoveredApp.close();
  }
});
