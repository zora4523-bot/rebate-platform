import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, openSuite, type Suite } from './db-kit.ts';
import { variants } from './fixtures.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it.each(variants)(
  '[AC-B1-12g#18] $variant 精确使用同 app、同 code、同 variant 的覆盖行',
  async (row) => {
    const f = await fixture(suite);
    const other = await fixture(suite);
    await other.template(row.variant, {
      title_override: '其他应用标题',
      body_override: '其他应用正文',
    });
    await f.template(row.variant, {
      code: 'APPEAL_RESULT',
      title_override: '其他类型标题',
      body_override: '其他类型正文',
    });
    await f.template('default', { title_override: '默认变体标题', body_override: '默认变体正文' });
    await f.template(row.variant, {
      title_override: '账户状态更新',
      body_override: '账户状态已更新。',
    });
    await f.deliver(f.event({ from: row.from, to: row.to, frozen_until: row.frozen_until }));
    const rows = await f.rows();
    expect(rows.inbox).toMatchObject([
      { title: '账户状态更新', body: '账户状态已更新。', route: null },
    ]);
    expect(rows.logs).toHaveLength(1);
    expect(await other.rows()).toEqual({ inbox: [], logs: [] });
  },
);

it('[AC-B1-12g#19] 只有其他 app、code、variant 覆盖行时用包内默认，不串用覆盖', async () => {
  const f = await fixture(suite);
  const other = await fixture(suite);
  await other.template('frozen', { body_override: '其他应用正文' });
  await f.template('frozen', { code: 'APPEAL_RESULT', body_override: '其他类型正文' });
  await f.template('frozen_until', { body_override: '定期冻结正文' });
  await f.template('default', { body_override: '默认变体正文' });
  await f.deliver(f.event());
  expect((await f.rows()).inbox).toMatchObject([
    {
      title: '账户通知',
      body: '你的账户提现已暂停，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
    },
  ]);
});

it.each([
  {
    title_override: '标题覆盖',
    body_override: null,
    title: '标题覆盖',
    body: '你的账户提现已恢复。',
  },
  { title_override: null, body_override: '恢复提现。', title: '账户通知', body: '恢复提现。' },
  { title_override: null, body_override: null, title: '账户通知', body: '你的账户提现已恢复。' },
])('[AC-B1-12g#20] 数据库标题和正文独立回退：$title / $body', async (row) => {
  const f = await fixture(suite);
  await f.template('unfrozen', {
    title_override: row.title_override,
    body_override: row.body_override,
  });
  await f.deliver(f.event({ from: 'frozen', to: 'normal', reason_category: null }));
  expect((await f.rows()).inbox).toMatchObject([{ title: row.title, body: row.body }]);
});

it('[AC-B1-12g#21] 覆盖正文替换原因与期限，模板渠道与路由不能使本通知变成推送或短信', async () => {
  const f = await fixture(suite);
  await f.template('frozen_until', {
    category: 'marketing',
    channels: ['push', 'sms'],
    route: JSON.stringify({ route: 'Wallet', params: {} }),
    title_override: '账户通知更新',
    body_override: '提现暂停至 {frozen_until}；原因：{reason_category}。',
  });
  await f.deliver(
    f.event({ frozen_until: '2026-11-29T16:00:00.000Z', reason_category: 'account_security' }),
  );
  const rows = await f.rows();
  expect(rows.inbox).toMatchObject([
    {
      title: '账户通知更新',
      body: '提现暂停至 11-30 00:00；原因：账户安全核验。',
      route: null,
    },
  ]);
  expect(rows.logs.map((row) => ({ channel: row.channel, status: row.status }))).toEqual([
    { channel: 'inbox', status: 'success' },
  ]);
});
