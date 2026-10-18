import { expect, it } from 'vitest';
import { renderRiskStateMessage } from '../../../../apps/api/src/modules/notification/application/risk-state-message.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { NOW, payload, variants } from './fixtures.ts';

it.each(variants)(
  '[AC-B1-12g#1] $variant 使用 BR-TEXT-23 逐字文案、服务类别、仅站内信和空路由',
  (row) => {
    const result = renderRiskStateMessage(
      payload({
        from: row.from,
        to: row.to,
        frozen_until: row.frozen_until,
        reason_category: row.to === 'normal' ? null : 'abnormal_trade',
      }),
      null,
      new FixedClock(NOW),
    );
    expect(result).toStrictEqual({
      code: 'RISK_STATE_CHANGED',
      variant: row.variant,
      category: 'service',
      channels: ['inbox'],
      title: '账户通知',
      body: row.body,
      route: null,
    });
  },
);

it.each([
  ['malicious_rights', '你的账户提现已暂停，原因：异常售后维权。如有疑问，可在帮助中心提交申诉。'],
  ['fraud_invite', '你的账户提现已暂停，原因：异常邀请行为。如有疑问，可在帮助中心提交申诉。'],
  ['abnormal_trade', '你的账户提现已暂停，原因：异常交易。如有疑问，可在帮助中心提交申诉。'],
  ['account_security', '你的账户提现已暂停，原因：账户安全核验。如有疑问，可在帮助中心提交申诉。'],
  ['other', '你的账户提现已暂停，原因：违反用户协议。如有疑问，可在帮助中心提交申诉。'],
] as const)('[AC-B1-12g#2] 原因类别 %s 转成用户文案', (category, body) => {
  expect(
    renderRiskStateMessage(payload({ reason_category: category }), null, new FixedClock(NOW))?.body,
  ).toBe(body);
});

it.each([
  ['normal', 'appealing'],
  ['frozen', 'appealing'],
  ['banned', 'appealing'],
  ['appealing', 'normal'],
  ['appealing', 'frozen'],
  ['appealing', 'banned'],
] as const)('[AC-B1-12g#3] %s → %s 属于申诉通知，不生成风控变更信', (from, to) => {
  expect(
    renderRiskStateMessage(
      payload({ from, to, frozen_until: '2026-11-29T16:00:00.000Z' }),
      null,
      new FixedClock(NOW),
    ),
  ).toBeNull();
});

it('[AC-B1-12g#4] 冻结转封禁按目标生成 banned 文案', () => {
  expect(
    renderRiskStateMessage(payload({ from: 'frozen', to: 'banned' }), null, new FixedClock(NOW)),
  ).toMatchObject({
    variant: 'banned',
    body: '你的账号已被限制使用，原因：异常交易。可在说明页提交申诉。',
  });
});

it.each([
  [
    '2026-12-31T15:59:00.000Z',
    '2026-12-31T16:07:00.000Z',
    '你的账户提现已暂停至 2027-01-01 00:07，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
  [
    '2026-05-31T16:00:00.000Z',
    '2026-06-01T01:05:00.000Z',
    '你的账户提现已暂停至 06-01 09:05，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
  [
    '2026-12-31T16:00:00.000Z',
    '2026-12-31T16:07:00.000Z',
    '你的账户提现已暂停至 01-01 00:07，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
  [
    '2026-12-31T16:00:00.000Z',
    '2027-01-01T01:05:00.000Z',
    '你的账户提现已暂停至 01-01 09:05，原因：异常交易。如有疑问，可在帮助中心提交申诉。',
  ],
] as const)(
  '[AC-B1-12g#5] 当前 %s、到期 %s 按上海年份判断跨年，并使用24小时制补零',
  (now, frozen_until, body) => {
    expect(renderRiskStateMessage(payload({ frozen_until }), null, new FixedClock(now))?.body).toBe(
      body,
    );
  },
);

it.each([
  { title_override: null, body_override: null, title: '账户通知', body: '你的账户提现已恢复。' },
  {
    title_override: '账户状态更新',
    body_override: null,
    title: '账户状态更新',
    body: '你的账户提现已恢复。',
  },
  {
    title_override: null,
    body_override: '现在可以提现。',
    title: '账户通知',
    body: '现在可以提现。',
  },
  {
    title_override: '账户状态更新',
    body_override: '现在可以提现。',
    title: '账户状态更新',
    body: '现在可以提现。',
  },
])('[AC-B1-12g#6] 标题和正文分别覆盖，空值各自回退默认：$title / $body', (row) => {
  expect(
    renderRiskStateMessage(
      payload({ from: 'frozen', to: 'normal', reason_category: null }),
      {
        title_override: row.title_override,
        body_override: row.body_override,
      },
      new FixedClock(NOW),
    ),
  ).toMatchObject({ title: row.title, body: row.body });
});

it('[AC-B1-12g#7] 覆盖正文的所有重复变量照样替换', () => {
  expect(
    renderRiskStateMessage(
      payload({ frozen_until: '2026-11-29T16:00:00.000Z' }),
      {
        title_override: '账户状态更新',
        body_override:
          '原因：{reason_category}；至 {frozen_until}。再次确认：{reason_category}，{frozen_until}。',
      },
      new FixedClock(NOW),
    ),
  ).toStrictEqual({
    code: 'RISK_STATE_CHANGED',
    variant: 'frozen_until',
    category: 'service',
    channels: ['inbox'],
    title: '账户状态更新',
    body: '原因：异常交易；至 11-30 00:00。再次确认：异常交易，11-30 00:00。',
    route: null,
  });
});

it('[AC-B1-12g#27] normal → normal 没有对应变体，不生成通知', () => {
  expect(
    renderRiskStateMessage(
      payload({ from: 'normal', to: 'normal', reason_category: null }),
      null,
      new FixedClock(NOW),
    ),
  ).toBeNull();
});
