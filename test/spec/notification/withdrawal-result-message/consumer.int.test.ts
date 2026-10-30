// B1-12u through the real worker assembly (AppModule worker entry, in-memory queue, no polling):
// the registered evt.notification-withdrawal-result handler, processed_events, the push dispatched
// after the commit (B1-12o), no SMS and no other job (task brief §9.2 ④⑤).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';
import { assembled } from '../risk-state-message/worker-kit.ts';
import { failInsert } from '../risk-state-message/db-kit.ts';
import { CONSUMER, EVENT, NOW, QUEUE, TITLES, fixture, job, openSuite, type Suite } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await suite?.close();
});

async function processed(f: Awaited<ReturnType<typeof fixture>>, eventId: string) {
  return f.db
    .selectFrom('processed_events')
    .select(['event_id', 'consumer'])
    .where('event_id', '=', eventId)
    .execute();
}

it('[AC-B1-12u#26] 真实发布 wallet.withdrawal_changed 路由到唯一 worker 消费者；两次投递只一条站内信，推送在提交后发起（无可用推送登记 → failed，不停在 queued），不排其他任务', async () => {
  const f = await fixture(suite);
  const row = await f.withdrawal({ status: 'PAID_API', amount_fen: 1000n, tax_fen: 80n });
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    const send = vi.fn<JobQueue['send']>(
      async (_queue, _name, _payload, options) => options.id ?? null,
    );
    const bus = createEventBus({ queue: { send }, clock: f.clock });
    const event = f.event(row, 'PAID_API');
    await f.db.transaction().execute((trx) =>
      bus.publish(trx, {
        appId: event.appId,
        eventId: event.eventId,
        name: EVENT,
        payload: event.payload,
      }),
    );
    const ours = send.mock.calls.filter((call) => call[0] === QUEUE);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.slice(0, 3)).toEqual([
      QUEUE,
      EVENT,
      { app_id: f.appId, v: 1, occurred_at: NOW, data: event.payload },
    ]);
    const [queue, name, payload, options] = ours[0]!;
    for (const attempt of [1, 2]) {
      await matches[0]!.handler({ id: options.id!, queue, name, payload, attempt });
    }
    const { inbox, logs } = await f.rows();
    expect(inbox).toMatchObject([
      {
        user_id: f.userId,
        code: 'WD_SUCCESS',
        title: TITLES.WD_SUCCESS,
        body: '提现已到账：¥9.2 已转入支付宝',
      },
    ]);
    expect(inbox).toHaveLength(1);
    expect(logs.map((log) => [log.channel, log.dedupe_key, log.status])).toEqual([
      ['inbox', `${row.id}:PAID_API`, 'success'],
      ['push', `${row.id}:PAID_API:push`, 'failed'],
    ]);
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12u#27] worker 上用户关闭服务类推送 → 只写站内信，推送日志 suppressed(push_disabled)', async () => {
  const f = await fixture(suite);
  await f.settings({ service_push: false, subscription_push: true, marketing_push: true });
  const row = await f.withdrawal({ status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' });
  const event = f.event(row, 'FAILED');
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    const { inbox, logs } = await f.rows();
    expect(inbox).toMatchObject([{ user_id: f.userId, code: 'WD_FAILED' }]);
    expect(inbox).toHaveLength(1);
    expect(logs.map((log) => [log.channel, log.status, log.suppress_reason])).toEqual([
      ['inbox', 'success', null],
      ['push', 'suppressed', 'push_disabled'],
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each(['PENDING_REVIEW', 'APPROVED', 'PAYING'])(
  '[AC-B1-12u#28] worker 确认 %s 事件但不发信、不写日志、不排其他任务',
  async (status) => {
    const f = await fixture(suite);
    const row = await f.withdrawal({ status: 'PAID_API' });
    const event = f.event(row, status);
    const app = await assembled('worker', f.db, f.clock);
    try {
      const matches = app.registrations.filter((r) => r.name === QUEUE);
      expect(matches).toHaveLength(1);
      await matches[0]!.handler(job(event));
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      expect(await processed(f, event.eventId)).toEqual([
        { event_id: event.eventId, consumer: CONSUMER },
      ]);
      expect(app.sends).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('[AC-B1-12u#29] worker 遇单据不存在：确认事件、不写、不抛', async () => {
  const f = await fixture(suite);
  const event = f.event({ id: randomUUID(), user_id: f.userId }, 'REJECTED');
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[AC-B1-12u#30] worker 写入失败时 processed_events 一起回滚，重投成功后只确认一次、只一条站内信', async () => {
  const f = await fixture(suite);
  const row = await f.withdrawal({ status: 'REJECTED', reject_reason_code: 'NEGATIVE_BALANCE' });
  const event = f.event(row, 'REJECTED');
  const fault = failInsert('inbox_messages');
  const app = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await expect(matches[0]!.handler(job(event))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(await processed(f, event.eventId)).toEqual([]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
  const recovered = await assembled('worker', f.db, f.clock);
  try {
    const matches = recovered.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job({ ...event, attempt: 2 }));
    const { inbox } = await f.rows();
    expect(inbox).toMatchObject([
      {
        code: 'WD_REJECTED',
        body: '提现未通过：有订单被扣回，冻结金额已用于抵扣；抵扣后的余额以钱包显示为准',
      },
    ]);
    expect(inbox).toHaveLength(1);
    expect(await processed(f, event.eventId)).toEqual([
      { event_id: event.eventId, consumer: CONSUMER },
    ]);
    expect(recovered.sends).not.toHaveBeenCalled();
  } finally {
    await recovered.close();
  }
});
