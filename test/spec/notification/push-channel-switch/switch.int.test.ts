// 规则测试（B1-12y；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」：后台关闭的渠道不再发、站内信不能由
// 后台增删；BR-TEXT-09 细则「渠道」）：push-send 的推送判定看 notify_templates.channels。
// - 该 app / code / variant 的 channels 不含 push → 不入队推送、不写推送记录（也不记 suppressed），站内信与
//   站内信日志照写，不调推送通道；用户自己的分类开关逻辑照旧。
// - 只看本变体的行：别的变体关了推送不影响本变体。
// - 记录后才关掉推送：之后的 dispatch 不再调推送通道。
// 夹具复用 B1-12o 的 push-send/kit.ts（只读引用，不改）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { eventOf, fixture, type Fixture } from '../push-send/kit.ts';

const database = databaseFixture(createTestDatabase);

type Channel = 'inbox' | 'push' | 'sms';

async function channelsOf(f: Fixture, channels: readonly Channel[], variant = 'default') {
  await f.db
    .insertInto('notify_templates')
    .values({
      app_id: f.app_id,
      code: f.input.code,
      variant,
      category: 'service',
      channels: [...channels],
    })
    .execute();
}

async function logsOf(f: Fixture) {
  const { inbox, logs } = await f.rows();
  return {
    inbox: inbox.map((m) => ({ code: m.code, title: m.title, body: m.body })),
    logs: logs
      .map((l) => ({ channel: l.channel, dedupe_key: l.dedupe_key, status: l.status }))
      .sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key)),
  };
}

it.each([{ channels: ['inbox'] as const }, { channels: ['inbox', 'sms'] as const }])(
  '[AC-B1-12y#17] channels 不含 push（$channels）：只写站内信与站内信日志，不写推送记录、不调推送通道，dispatch 无事可做（skipped）',
  async ({ channels }) => {
    const db = database();
    const f = await fixture(db, 'WD_FAILED');
    await f.registration();
    await channelsOf(f, channels);
    const core = createPushSendCore({
      clock: f.clock,
      channel: f.channel,
      sessionValidity: f.sessionValidity,
    });
    await db.transaction().execute((trx) => core.record(trx, f.input));
    const outcome = await core.dispatch(db, eventOf(f.input));
    const got = { outcome, pushCalls: f.channel.send.mock.calls.length, ...(await logsOf(f)) };
    expect(got).toEqual({
      outcome: 'skipped',
      pushCalls: 0,
      inbox: [{ code: 'WD_FAILED', title: f.input.title, body: f.input.body }],
      logs: [{ channel: 'inbox', dedupe_key: f.input.eventKey, status: 'success' }],
    });
  },
);

it('[AC-B1-12y#18] channels 不含 push 且用户关了「服务」类推送：同样不写推送记录（不记 suppressed），站内信照写', async () => {
  const db = database();
  const f = await fixture(db, 'WD_FAILED');
  await f.registration();
  await channelsOf(f, ['inbox', 'sms']);
  await f.settings({ service_push: false, subscription_push: true, marketing_push: true });
  await f.send();
  const got = { pushCalls: f.channel.send.mock.calls.length, ...(await logsOf(f)) };
  expect(got).toEqual({
    pushCalls: 0,
    inbox: [{ code: 'WD_FAILED', title: f.input.title, body: f.input.body }],
    logs: [{ channel: 'inbox', dedupe_key: f.input.eventKey, status: 'success' }],
  });
});

it('[AC-B1-12y#19] 只看本变体的 channels：manual 变体不含 push → 不推送；default 变体含 push → 照常推送成功', async () => {
  const db = database();
  const f = await fixture(db, 'WD_FAILED');
  await f.registration();
  await channelsOf(f, ['inbox', 'push', 'sms'], 'default');
  await channelsOf(f, ['inbox', 'sms'], 'manual');
  const manualKey = `event-${randomUUID()}`;
  const defaultKey = `event-${randomUUID()}`;
  await f.send({ variant: 'manual', eventKey: manualKey });
  const afterManual = { pushCalls: f.channel.send.mock.calls.length, ...(await logsOf(f)) };
  expect(afterManual.pushCalls).toBe(0);
  expect(afterManual.logs).toEqual([
    { channel: 'inbox', dedupe_key: manualKey, status: 'success' },
  ]);
  await f.send({ variant: 'default', eventKey: defaultKey });
  const afterDefault = await logsOf(f);
  const expected = [
    { channel: 'inbox', dedupe_key: defaultKey, status: 'success' },
    { channel: 'push', dedupe_key: `${defaultKey}:push`, status: 'success' },
    { channel: 'inbox', dedupe_key: manualKey, status: 'success' },
  ].sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key));
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(afterDefault.inbox).toHaveLength(2);
  expect(afterDefault.logs).toEqual(expected);
});

it('[AC-B1-12y#20] 记录后后台才关掉推送（channels 去掉 push）：之后的 dispatch 不再调推送通道，推送记录不会变成 success；站内信仍在', async () => {
  const db = database();
  const f = await fixture(db, 'WD_FAILED');
  await f.registration();
  await channelsOf(f, ['inbox', 'push']);
  const core = createPushSendCore({
    clock: f.clock,
    channel: f.channel,
    sessionValidity: f.sessionValidity,
  });
  await db.transaction().execute((trx) => core.record(trx, f.input));
  await db
    .updateTable('notify_templates')
    .set({ channels: ['inbox'] })
    .where('app_id', '=', f.app_id)
    .where('code', '=', f.input.code)
    .execute();
  await core.dispatch(db, eventOf(f.input));
  const { inbox, logs } = await logsOf(f);
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(logs.find((l) => l.channel === 'push')?.status).not.toBe('success');
  expect(inbox).toEqual([{ code: 'WD_FAILED', title: f.input.title, body: f.input.body }]);
});
