import { expect, it } from 'vitest';
import { renderClaimResultMessage } from '../../../../apps/api/src/modules/notification/application/claim-result-message.ts';

it.each([
  [0n, '订单找回成功，预估返 ¥0'],
  [1n, '订单找回成功，预估返 ¥0.01'],
  [990n, '订单找回成功，预估返 ¥9.9'],
  [1000n, '订单找回成功，预估返 ¥10'],
  [123456n, '订单找回成功，预估返 ¥1234.56'],
  [9007199254740993n, '订单找回成功，预估返 ¥90071992547409.93'],
] as const)(
  '[AC-B1-12r#1] approved 金额 %s 分精确格式化、只站内、service、无重复货币符号',
  (rebate_fen, body) => {
    expect(
      renderClaimResultMessage({ status: 'approved', rebate_fen, reject_reason: null }, null),
    ).toEqual({
      code: 'CLAIM_RESULT',
      variant: 'approved',
      category: 'service',
      channels: ['inbox'],
      title: '找回结果',
      body,
      route: null,
    });
  },
);

it.each([
  ['NO_EVIDENCE', '订单找回未通过：没有找到这笔订单经凑狸下单的记录'],
  ['NOT_IN_POOL', '订单找回未通过：该订单已由平台记录归属，找回已关闭'],
  ['EXPIRED_CLICK', '订单找回未通过：暂无法找回该订单，请联系客服'],
  ['NOT_TRACKED', '订单找回未通过：暂无法找回该订单，请联系客服'],
  ['OTHER_TLJ', '订单找回未通过：暂无法找回该订单，请联系客服'],
  ['FRAUD', '订单找回未通过：暂无法找回该订单，请联系客服'],
  ['OTHER', '订单找回未通过：暂无法找回该订单，请联系客服'],
  ['ORDER_INVALID', '订单找回未通过：暂无法找回该订单，请联系客服'],
] as const)(
  '[AC-B1-12r#2] rejected 原因 %s 取找回原因字典，缺失使用明确默认',
  (reject_reason, body) => {
    expect(
      renderClaimResultMessage({ status: 'rejected', rebate_fen: 999n, reject_reason }, null),
    ).toEqual({
      code: 'CLAIM_RESULT',
      variant: 'rejected',
      category: 'service',
      channels: ['inbox'],
      title: '找回结果',
      body,
      route: null,
    });
  },
);

it.each(['cancelled', 'submitted', 'auto_matched', 'manual_review', 'future_status'])(
  '[AC-B1-12r#3] %s 无通知，即使提供覆盖模板',
  (status) => {
    expect(
      renderClaimResultMessage(
        { status, rebate_fen: 123n, reject_reason: 'NO_EVIDENCE' },
        {
          title_override: '覆盖标题',
          body_override: '覆盖正文',
        },
      ),
    ).toBeNull();
  },
);

it.each([
  {
    title_override: '审核完成',
    body_override: null,
    title: '审核完成',
    body: '订单找回成功，预估返 ¥3.21',
  },
  {
    title_override: null,
    body_override: '找回获批，预计 {rebate}',
    title: '找回结果',
    body: '找回获批，预计 ¥3.21',
  },
  {
    title_override: '审核完成',
    body_override: '预计 {rebate}，再次确认 {rebate}',
    title: '审核完成',
    body: '预计 ¥3.21，再次确认 ¥3.21',
  },
])(
  '[AC-B1-12r#4] approved 标题与正文独立覆盖并替换全部金额变量：$body',
  ({ title_override, body_override, title, body }) => {
    expect(
      renderClaimResultMessage(
        { status: 'approved', rebate_fen: 321n, reject_reason: null },
        { title_override, body_override },
      ),
    ).toMatchObject({ title, body, category: 'service', channels: ['inbox'], route: null });
  },
);

it('[AC-B1-12r#5] rejected 覆盖正文仍替换为找回原因字典值', () => {
  expect(
    renderClaimResultMessage(
      { status: 'rejected', rebate_fen: 0n, reject_reason: 'NO_EVIDENCE' },
      {
        title_override: '审核完成',
        body_override: '未通过：{reason}',
      },
    ),
  ).toMatchObject({ title: '审核完成', body: '未通过：没有找到这笔订单经凑狸下单的记录' });
});
