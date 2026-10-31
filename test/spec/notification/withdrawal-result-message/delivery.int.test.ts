// B1-12u delivery on real PostgreSQL (BR-TEXT-09, BR-TEXT-08, BR-WDR-26, BR-WATCH-19 ③ / 例 5;
// D10-228, D10-235, D10-260). The consumer is created in each test body (fixture.deliver /
// fixture.handle), so the skeleton fails each case with NotImplemented.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { failInsert } from '../risk-state-message/db-kit.ts';
import {
  CHANGE_ACCOUNT,
  CHANNEL_NAMES,
  FAIL_FALLBACK,
  FAIL_REASONS,
  NOW,
  REJECT_REASONS,
  TITLES,
  eventOf,
  fixture,
  openSuite,
  seedUser,
  seedWithdrawal,
  type Suite,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await suite?.close();
});

const NEGATIVE_BALANCE_BODY = `提现未通过：${REJECT_REASONS.NEGATIVE_BALANCE}；抵扣后的余额以钱包显示为准`;

it.each([
  ['PAID_API', 'alipay'],
  ['PAID_MANUAL', 'bank_card'],
  ['PAID_API', 'wechat'],
] as const)(
  '[AC-B1-12u#10] %s / %s → WD_SUCCESS：一条站内信（净额、渠道名）、站内日志键 {withdrawal_id}:{status}，提交后推送一条，提现单不变',
  async (status, payout_channel) => {
    const f = await fixture(suite);
    const target = await f.token();
    const row = await f.withdrawal({
      status,
      payout_channel,
      amount_fen: 1000n,
      fee_fen: 0n,
      tax_fen: 80n,
    });
    await f.deliver(f.event(row, status));
    const { inbox, logs } = await f.rows();
    const body = `提现已到账：¥9.2 已转入${CHANNEL_NAMES[payout_channel]}`;
    expect(inbox).toMatchObject([
      {
        app_id: f.appId,
        user_id: f.userId,
        code: 'WD_SUCCESS',
        title: TITLES.WD_SUCCESS,
        body,
        read_at: null,
      },
    ]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.created_at.toISOString()).toBe(NOW);
    expect(logs).toMatchObject([
      {
        user_id: f.userId,
        code: 'WD_SUCCESS',
        channel: 'inbox',
        dedupe_key: `${row.id}:${status}`,
        status: 'success',
      },
      {
        user_id: f.userId,
        code: 'WD_SUCCESS',
        channel: 'push',
        dedupe_key: `${row.id}:${status}:push`,
        status: 'success',
      },
    ]);
    expect(logs).toHaveLength(2);
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    expect(f.channel.send.mock.calls[0]?.slice(0, 2)).toEqual([
      [target],
      { message_id: inbox[0]!.message_id, title: TITLES.WD_SUCCESS, body },
    ]);
    const after = await f.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(row);
  },
);

it.each(
  (['RISK_SUSPECT', 'ORDER_ABNORMAL', 'PAYEE_INFO_INVALID', 'USER_REQUEST', 'OTHER'] as const).map(
    (code) => [code] as const,
  ),
)('[AC-B1-12u#11] REJECTED / %s → WD_REJECTED 原句带申请额，站内信一条、推送一条', async (code) => {
  const f = await fixture(suite);
  const target = await f.token();
  const row = await f.withdrawal({
    status: 'REJECTED',
    reject_reason_code: code,
    amount_fen: 1000n,
    fee_fen: 0n,
    tax_fen: 80n,
  });
  await f.deliver(f.event(row, 'REJECTED'));
  const { inbox, logs } = await f.rows();
  const body = `提现未通过：${REJECT_REASONS[code]}，¥10 已退回余额`;
  expect(inbox).toMatchObject([
    { user_id: f.userId, code: 'WD_REJECTED', title: TITLES.WD_REJECTED, body },
  ]);
  expect(inbox).toHaveLength(1);
  expect(logs.map((log) => [log.channel, log.dedupe_key, log.status])).toEqual([
    ['inbox', `${row.id}:REJECTED`, 'success'],
    ['push', `${row.id}:REJECTED:push`, 'success'],
  ]);
  expect(f.channel.send.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    [[target], { message_id: inbox[0]!.message_id, title: TITLES.WD_REJECTED, body }],
  ]);
  // The reviewer's internal note never reaches the user.
  expect(JSON.stringify(inbox)).not.toContain('仅内部可见的合成备注');
});

it('[AC-B1-12u#12] REJECTED / NEGATIVE_BALANCE → 不带金额的新句，站内信与推送各一条', async () => {
  const f = await fixture(suite);
  await f.token();
  const row = await f.withdrawal({
    status: 'REJECTED',
    reject_reason_code: 'NEGATIVE_BALANCE',
    blocked_reason: 'NEGATIVE_BALANCE',
    amount_fen: 1000n,
    fee_fen: 0n,
    tax_fen: 0n,
  });
  await f.deliver(f.event(row, 'REJECTED'));
  const { inbox, logs } = await f.rows();
  expect(inbox).toMatchObject([
    {
      user_id: f.userId,
      code: 'WD_REJECTED',
      title: TITLES.WD_REJECTED,
      body: NEGATIVE_BALANCE_BODY,
    },
  ]);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]!.body).not.toContain('¥');
  expect(logs.map((log) => [log.channel, log.dedupe_key, log.status])).toEqual([
    ['inbox', `${row.id}:REJECTED`, 'success'],
    ['push', `${row.id}:REJECTED:push`, 'success'],
  ]);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it.each([
  ['PAYEE_NOT_EXIST', `${FAIL_REASONS.PAYEE_NOT_EXIST}，¥10 已退回余额${CHANGE_ACCOUNT}`],
  [
    'PAYEE_USER_INFO_ERROR',
    `${FAIL_REASONS.PAYEE_USER_INFO_ERROR}，¥10 已退回余额${CHANGE_ACCOUNT}`,
  ],
  [
    'PAYEE_ACCOUNT_STATUS_ERROR',
    `${FAIL_REASONS.PAYEE_ACCOUNT_STATUS_ERROR}，¥10 已退回余额${CHANGE_ACCOUNT}`,
  ],
  ['PAYEE_ACCOUNT_FROZEN', `${FAIL_FALLBACK}，¥10 已退回余额`],
  ['BALANCE_IS_NOT_ENOUGH', `${FAIL_FALLBACK}，¥10 已退回余额`],
  [null, `${FAIL_FALLBACK}，¥10 已退回余额`],
] as const)(
  '[AC-B1-12u#13] FAILED / %s → WD_FAILED（命中映射用映射文案，账号类追加改账号提示；未命中用兜底句）；站内信与推送各一条，不写短信记录',
  async (fail_code, tail) => {
    const f = await fixture(suite);
    await f.token();
    const row = await f.withdrawal({
      status: 'FAILED',
      fail_code,
      amount_fen: 1000n,
      fee_fen: 0n,
      tax_fen: 80n,
    });
    await f.deliver(f.event(row, 'FAILED'));
    const { inbox, logs } = await f.rows();
    expect(inbox).toMatchObject([
      {
        user_id: f.userId,
        code: 'WD_FAILED',
        title: TITLES.WD_FAILED,
        body: `提现打款未成功：${tail}`,
      },
    ]);
    expect(inbox).toHaveLength(1);
    // TODO in the brief: no SMS until the owner's signature and template approval; no fake row.
    expect(logs.map((log) => [log.channel, log.dedupe_key, log.status])).toEqual([
      ['inbox', `${row.id}:FAILED`, 'success'],
      ['push', `${row.id}:FAILED:push`, 'success'],
    ]);
    expect(f.channel.send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['PENDING_REVIEW', 'PAID_API'],
  ['APPROVED', 'REJECTED'],
  ['PAYING', 'FAILED'],
  ['PAYING', 'PAID_MANUAL'],
  ['FUTURE_STATUS', 'PAID_API'],
] as const)(
  '[AC-B1-12u#14] 事件状态 %s 不发：即使提现单已前进到 %s 也不写站内信与日志、不推送',
  async (eventStatus, rowStatus) => {
    const f = await fixture(suite);
    await f.token();
    const row = await f.withdrawal({ status: rowStatus });
    await f.deliver(f.event(row, eventStatus));
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    expect(f.channel.send).not.toHaveBeenCalled();
  },
);

it('[AC-B1-12u#15] 同一提现同一终态重复投递（不同事件编号、再投原事件）→ 只一条站内信、一条推送，原文与时间不变', async () => {
  const f = await fixture(suite);
  await f.token();
  const row = await f.withdrawal({ status: 'REJECTED', reject_reason_code: 'OTHER' });
  const first = f.event(row, 'REJECTED');
  await f.deliver(first);
  const before = await f.rows();
  expect(before.inbox).toHaveLength(1);
  await f.deliver(f.event(row, 'REJECTED'));
  await f.deliver({ ...first, attempt: 2 });
  const after = await f.rows();
  expect(after).toEqual(before);
  expect(after.logs.map((log) => [log.channel, log.dedupe_key])).toEqual([
    ['inbox', `${row.id}:REJECTED`],
    ['push', `${row.id}:REJECTED:push`],
  ]);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12u#16] 同一提现同一终态在并发事务里投递 → PG 唯一约束最终只留一信、一条站内日志、一条推送日志，所有投递成功', async () => {
  const f = await fixture(suite);
  await f.token();
  const row = await f.withdrawal({ status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' });
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map(() => f.deliver(f.event(row, 'FAILED'))),
  );
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ]);
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(1);
  expect(logs.map((log) => [log.channel, log.dedupe_key])).toEqual([
    ['inbox', `${row.id}:FAILED`],
    ['push', `${row.id}:FAILED:push`],
  ]);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12u#17] 同一提现的 PAID_API 与 PAID_MANUAL 各算一个状态各发一条；不同提现的同一状态也各发一条', async () => {
  const f = await fixture(suite);
  const row = await f.withdrawal({ status: 'PAID_MANUAL', payout_channel: 'alipay' });
  const other = await f.withdrawal({ status: 'PAID_API', payout_channel: 'wechat' });
  await f.deliver(f.event(row, 'PAID_API'));
  await f.deliver(f.event(row, 'PAID_MANUAL'));
  await f.deliver(f.event(other, 'PAID_API'));
  const { inbox, logs } = await f.rows();
  expect(inbox.map((message) => [message.code, message.body]).sort()).toEqual(
    [
      ['WD_SUCCESS', '提现已到账：¥9.2 已转入支付宝'],
      ['WD_SUCCESS', '提现已到账：¥9.2 已转入支付宝'],
      ['WD_SUCCESS', '提现已到账：¥9.2 已转入微信零钱'],
    ].sort(),
  );
  expect(
    logs
      .filter((log) => log.channel === 'inbox')
      .map((log) => log.dedupe_key)
      .sort(),
  ).toEqual([`${row.id}:PAID_API`, `${row.id}:PAID_MANUAL`, `${other.id}:PAID_API`].sort());
});

it('[AC-B1-12u#18] 用户关闭「服务」类推送 → 只写站内信，推送日志 suppressed(push_disabled)，不调推送通道', async () => {
  const f = await fixture(suite);
  await f.token();
  await f.settings({ service_push: false, subscription_push: true, marketing_push: true });
  const row = await f.withdrawal({ status: 'PAID_API' });
  await f.deliver(f.event(row, 'PAID_API'));
  const { inbox, logs } = await f.rows();
  expect(inbox).toMatchObject([{ user_id: f.userId, code: 'WD_SUCCESS' }]);
  expect(inbox).toHaveLength(1);
  expect(logs.map((log) => [log.channel, log.status, log.suppress_reason])).toEqual([
    ['inbox', 'success', null],
    ['push', 'suppressed', 'push_disabled'],
  ]);
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('[AC-B1-12u#19] 只关订阅类与营销类推送不影响提现通知（服务类）：站内信与推送都发', async () => {
  const f = await fixture(suite);
  await f.token();
  await f.settings({ service_push: true, subscription_push: false, marketing_push: false });
  const row = await f.withdrawal({ status: 'REJECTED', reject_reason_code: 'NEGATIVE_BALANCE' });
  await f.deliver(f.event(row, 'REJECTED'));
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(1);
  expect(logs.map((log) => [log.channel, log.status])).toEqual([
    ['inbox', 'success'],
    ['push', 'success'],
  ]);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12u#20] 单据不存在（未知编号、别的 app 的单）→ 不写、不抛、不推送，记 warn', async () => {
  const f = await fixture(suite);
  await f.token();
  const missing = randomUUID();
  await f.deliver(f.event({ id: missing, user_id: f.userId }, 'PAID_API'));
  const otherApp = `wd-other-${randomUUID()}`;
  const stranger = await seedUser(f.db, otherApp);
  const foreign = await seedWithdrawal(
    f.db,
    { appId: otherApp, userId: stranger },
    { status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' },
  );
  await f.deliver(f.event({ id: foreign.id, user_id: f.userId }, 'FAILED'));
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  expect(await f.rows(otherApp)).toEqual({ inbox: [], logs: [] });
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.warnings(missing)).not.toEqual([]);
  expect(f.warnings(foreign.id)).not.toEqual([]);
});

it('[AC-B1-12u#21] 只通知该提现的用户：同 app 的其他用户与别的 app 不受影响', async () => {
  const f = await fixture(suite);
  const neighbour = await seedUser(f.db, f.appId);
  const otherApp = `wd-other-${randomUUID()}`;
  const stranger = await seedUser(f.db, otherApp);
  const mine = await f.withdrawal({ status: 'PAID_API' });
  const theirs = await seedWithdrawal(
    f.db,
    { appId: f.appId, userId: neighbour },
    { status: 'REJECTED', reject_reason_code: 'OTHER' },
  );
  await seedWithdrawal(f.db, { appId: otherApp, userId: stranger }, { status: 'PAID_API' });
  await f.deliver(f.event(mine, 'PAID_API'));
  let rows = await f.rows();
  expect(rows.inbox.map((message) => [message.user_id, message.code])).toEqual([
    [f.userId, 'WD_SUCCESS'],
  ]);
  expect(rows.logs.every((log) => log.user_id === f.userId)).toBe(true);
  expect(await f.rows(otherApp)).toEqual({ inbox: [], logs: [] });
  await f.deliver(f.event(theirs, 'REJECTED'));
  rows = await f.rows();
  expect(rows.inbox.map((message) => [message.user_id, message.code]).sort()).toEqual(
    [
      [f.userId, 'WD_SUCCESS'],
      [neighbour, 'WD_REJECTED'],
    ].sort(),
  );
  expect(await f.rows(otherApp)).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12u#22] 站内信与日志在调用方事务里写：提交前别的连接看不到，事务失败两表皆空，重投成功', async () => {
  const f = await fixture(suite);
  const row = await f.withdrawal({ status: 'PAID_API' });
  const event = f.event(row, 'PAID_API');
  const sut = f.consumer();
  await expect(
    f.db.transaction().execute(async (trx) => {
      await sut.handle(event, trx);
      const inside = await trx
        .selectFrom('inbox_messages')
        .select('code')
        .where('app_id', '=', f.appId)
        .execute();
      expect(inside).toEqual([{ code: 'WD_SUCCESS' }]);
      expect(await f.rows()).toEqual({ inbox: [], logs: [] });
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  await f.deliver(event);
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(1);
  expect(logs.filter((log) => log.channel === 'inbox')).toHaveLength(1);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-12u#23] %s 写入失败不吞错，两表一起回滚，重投成功',
  async (table) => {
    const f = await fixture(suite);
    const row = await f.withdrawal({ status: 'FAILED', fail_code: 'PAYEE_USER_INFO_ERROR' });
    const event = f.event(row, 'FAILED');
    const fault = failInsert(table);
    await expect(f.handle(event, f.db.withPlugin(fault.plugin))).rejects.toMatchObject({
      code: '22012',
    });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    await f.deliver(event);
    const { inbox } = await f.rows();
    expect(inbox).toMatchObject([
      {
        code: 'WD_FAILED',
        body: `提现打款未成功：${FAIL_REASONS.PAYEE_USER_INFO_ERROR}，¥10 已退回余额${CHANGE_ACCOUNT}`,
      },
    ]);
    expect(inbox).toHaveLength(1);
  },
);

it('[AC-B1-12u#24] notify_templates 覆盖按 app、code、variant 精确匹配：negative_balance 只管负余额驳回，default 管其余原因，别的 app 与别的 code 不串用', async () => {
  const f = await fixture(suite);
  await f.template('WD_REJECTED', 'negative_balance', { body_override: '抵扣说明：{reason}' });
  await f.template('WD_REJECTED', 'default', {
    title_override: '驳回通知',
    body_override: '驳回：{reason}，退回 {amount}',
  });
  await f.template('WD_FAILED', 'default', { body_override: '失败模板 {amount}' });
  await f.db
    .insertInto('notify_templates')
    .values({
      app_id: `wd-other-${randomUUID()}`,
      code: 'WD_SUCCESS',
      variant: 'default',
      category: 'service',
      channels: ['inbox', 'push'],
      title_override: '别的应用',
      body_override: '别的应用 {net}',
    })
    .execute();
  const negative = await f.withdrawal({
    status: 'REJECTED',
    reject_reason_code: 'NEGATIVE_BALANCE',
  });
  const risk = await f.withdrawal({
    status: 'REJECTED',
    reject_reason_code: 'RISK_SUSPECT',
    amount_fen: 1000n,
  });
  const paid = await f.withdrawal({ status: 'PAID_API', amount_fen: 1000n, tax_fen: 80n });
  await f.deliver(f.event(negative, 'REJECTED'));
  await f.deliver(f.event(risk, 'REJECTED'));
  await f.deliver(f.event(paid, 'PAID_API'));
  const { inbox } = await f.rows();
  expect(inbox.map((message) => [message.code, message.title, message.body]).sort()).toEqual(
    [
      ['WD_REJECTED', TITLES.WD_REJECTED, `抵扣说明：${REJECT_REASONS.NEGATIVE_BALANCE}`],
      ['WD_REJECTED', '驳回通知', `驳回：${REJECT_REASONS.RISK_SUSPECT}，退回 ¥10`],
      ['WD_SUCCESS', TITLES.WD_SUCCESS, '提现已到账：¥9.2 已转入支付宝'],
    ].sort(),
  );
});

it('[AC-B1-12u#25] 收件人与 app 取自事件与单据：载荷 user_id 指向别人时不发给别人', async () => {
  const f = await fixture(suite);
  const neighbour = await seedUser(f.db, f.appId);
  const row = await f.withdrawal({ status: 'PAID_API' });
  // A payload whose user is not the withdrawal's owner must never reach that other user.
  await f
    .deliver(eventOf(f.appId, { withdrawal_id: row.id, user_id: neighbour, status: 'PAID_API' }))
    .catch(() => undefined);
  const { inbox, logs } = await f.rows();
  expect(inbox.filter((message) => message.user_id === neighbour)).toEqual([]);
  expect(logs.filter((log) => log.user_id === neighbour)).toEqual([]);
  // The skeleton must not pass this case by doing nothing: the owner's own event still works.
  await f.deliver(f.event(row, 'PAID_API'));
  expect((await f.rows()).inbox.map((message) => message.user_id)).toEqual([f.userId]);
});
