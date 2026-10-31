// B1-12u render rules (BR-TEXT-09 细则模板表, BR-TEXT-08 原因, BR-TEXT-10 金额; D10-228, D10-235).
// Unit tests: no database. Expected texts are written out from the brief, never from the code.
import { expect, it } from 'vitest';
import {
  renderWithdrawalResultMessage,
  type WithdrawalResultFacts,
} from '../../../../apps/api/src/modules/notification/application/withdrawal-result-message.ts';

const CHANNEL_NAMES = { alipay: '支付宝', bank_card: '银行卡', wechat: '微信零钱' } as const;

const REJECT_REASONS = {
  RISK_SUSPECT: '账户存在异常，需要核实，请联系客服',
  ORDER_ABNORMAL: '部分订单状态待核实，请稍后重新申请',
  PAYEE_INFO_INVALID: '收款信息有误，请核对后重新申请',
  USER_REQUEST: '已按你的要求取消本次提现',
  OTHER: '其他原因，请联系客服',
} as const;

const NEGATIVE_BALANCE_BODY =
  '提现未通过：有订单被扣回，冻结金额已用于抵扣；抵扣后的余额以钱包显示为准';

/** Applied 1000 fen, tax 80 fen: {amount} = ¥10, {net} = ¥9.2. */
function facts(patch: Partial<WithdrawalResultFacts>): WithdrawalResultFacts {
  return {
    status: 'PAID_API',
    reject_reason_code: null,
    amount_fen: 1000n,
    net_fen: 920n,
    fail_code: null,
    payout_channel: 'alipay',
    ...patch,
  };
}

it.each([
  ['PAID_API', 'alipay'],
  ['PAID_API', 'bank_card'],
  ['PAID_API', 'wechat'],
  ['PAID_MANUAL', 'alipay'],
  ['PAID_MANUAL', 'bank_card'],
  ['PAID_MANUAL', 'wechat'],
] as const)(
  '[AC-B1-12u#1] %s / %s → WD_SUCCESS「提现已到账：{net} 已转入{payout_channel_name}」，取净额不取申请额，服务类',
  (status, payout_channel) => {
    expect(renderWithdrawalResultMessage(facts({ status, payout_channel }), null)).toStrictEqual({
      code: 'WD_SUCCESS',
      variant: 'default',
      category: 'service',
      title: '提现到账',
      body: `提现已到账：¥9.2 已转入${CHANNEL_NAMES[payout_channel]}`,
    });
  },
);

it.each([
  [0n, '¥0'],
  [1n, '¥0.01'],
  [990n, '¥9.9'],
  [1000n, '¥10'],
  [123456n, '¥1234.56'],
  [9007199254740993n, '¥90071992547409.93'],
] as const)('[AC-B1-12u#2] WD_SUCCESS 净额 %s 分按 BR-TEXT-10 精确格式化为 %s', (net_fen, yuan) => {
  const message = renderWithdrawalResultMessage(
    facts({ status: 'PAID_API', net_fen, amount_fen: net_fen + 500n }),
    null,
  );
  expect(message?.body).toBe(`提现已到账：${yuan} 已转入支付宝`);
});

it.each(Object.entries(REJECT_REASONS))(
  '[AC-B1-12u#3] REJECTED / %s → WD_REJECTED「提现未通过：{reason}，{amount} 已退回余额」，金额取申请额',
  (code, reason) => {
    expect(
      renderWithdrawalResultMessage(facts({ status: 'REJECTED', reject_reason_code: code }), null),
    ).toStrictEqual({
      code: 'WD_REJECTED',
      variant: 'default',
      category: 'service',
      title: '提现未通过',
      body: `提现未通过：${reason}，¥10 已退回余额`,
    });
  },
);

it.each([1n, 1000n, 9007199254740993n])(
  '[AC-B1-12u#4] REJECTED / NEGATIVE_BALANCE（申请额 %s 分）→ negative_balance 变体，不带金额、不说退回',
  (amount_fen) => {
    const message = renderWithdrawalResultMessage(
      facts({
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
        amount_fen,
        net_fen: amount_fen,
      }),
      null,
    );
    expect(message).toStrictEqual({
      code: 'WD_REJECTED',
      variant: 'negative_balance',
      category: 'service',
      title: '提现未通过',
      body: NEGATIVE_BALANCE_BODY,
    });
    expect(message?.body).not.toContain('¥');
    expect(message?.body).not.toContain('退回');
  },
);

it.each([
  ['PAYEE_NOT_EXIST', '收款支付宝账号不存在'],
  ['PAYEE_USER_INFO_ERROR', '收款账号姓名与实名信息不一致'],
  ['PAYEE_ACCOUNT_STATUS_ERROR', '收款支付宝账号状态异常'],
] as const)(
  '[AC-B1-12u#5] FAILED / %s 命中映射且为账号类 → WD_FAILED 句末追加「，可修改收款账号后重试」',
  (fail_code, reason) => {
    expect(
      renderWithdrawalResultMessage(facts({ status: 'FAILED', fail_code }), null),
    ).toStrictEqual({
      code: 'WD_FAILED',
      variant: 'default',
      category: 'service',
      title: '提现打款未成功',
      body: `提现打款未成功：${reason}，¥10 已退回余额，可修改收款账号后重试`,
    });
  },
);

it.each([
  // PAYEE_ prefix but not in the list: no mapping, no change-account hint (D10-229).
  ['PAYEE_ACCOUNT_FROZEN'],
  ['BALANCE_IS_NOT_ENOUGH'],
  ['payee_not_exist'],
  [null],
] as const)(
  '[AC-B1-12u#6] FAILED / %s 未命中映射 → {reason} 用不带金额的兜底句，不追加改账号提示',
  (fail_code) => {
    expect(
      renderWithdrawalResultMessage(facts({ status: 'FAILED', fail_code }), null),
    ).toStrictEqual({
      code: 'WD_FAILED',
      variant: 'default',
      category: 'service',
      title: '提现打款未成功',
      body: '提现打款未成功：收款渠道未能完成这笔转账，¥10 已退回余额',
    });
  },
);

it.each([
  [1n, '¥0.01'],
  [990n, '¥9.9'],
  [123456n, '¥1234.56'],
  [9007199254740993n, '¥90071992547409.93'],
] as const)(
  '[AC-B1-12u#7] 驳回与失败的 {amount} 取申请额 %s 分，精确格式化为 %s（不取净额）',
  (amount_fen, yuan) => {
    const rejected = renderWithdrawalResultMessage(
      facts({ status: 'REJECTED', reject_reason_code: 'OTHER', amount_fen, net_fen: 0n }),
      null,
    );
    const failed = renderWithdrawalResultMessage(
      facts({ status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST', amount_fen, net_fen: 0n }),
      null,
    );
    expect([rejected?.body, failed?.body]).toEqual([
      `提现未通过：其他原因，请联系客服，${yuan} 已退回余额`,
      `提现打款未成功：收款支付宝账号不存在，${yuan} 已退回余额，可修改收款账号后重试`,
    ]);
  },
);

it.each(['PENDING_REVIEW', 'APPROVED', 'PAYING', 'paid_api', 'FUTURE_STATUS'])(
  '[AC-B1-12u#8] 状态 %s 不是结果态：无消息，即使给了覆盖模板',
  (status) => {
    expect(
      renderWithdrawalResultMessage(
        facts({ status, reject_reason_code: 'OTHER', fail_code: 'PAYEE_NOT_EXIST' }),
        { title_override: '覆盖标题', body_override: '覆盖正文 {amount}' },
      ),
    ).toBeNull();
  },
);

it.each([
  {
    label: 'WD_SUCCESS 只覆盖标题',
    input: facts({ status: 'PAID_MANUAL', payout_channel: 'wechat' }),
    override: { title_override: '钱到了', body_override: null },
    title: '钱到了',
    body: '提现已到账：¥9.2 已转入微信零钱',
  },
  {
    label: 'WD_SUCCESS 覆盖正文并替换全部变量',
    input: facts({ status: 'PAID_API', payout_channel: 'bank_card' }),
    override: {
      title_override: null,
      body_override: '{net} 到{payout_channel_name}，再说一次 {net}',
    },
    title: '提现到账',
    body: '¥9.2 到银行卡，再说一次 ¥9.2',
  },
  {
    label: 'WD_REJECTED default 覆盖正文',
    input: facts({ status: 'REJECTED', reject_reason_code: 'USER_REQUEST' }),
    override: { title_override: '驳回通知', body_override: '驳回：{reason}（退回 {amount}）' },
    title: '驳回通知',
    body: '驳回：已按你的要求取消本次提现（退回 ¥10）',
  },
  {
    label: 'WD_REJECTED negative_balance 覆盖正文',
    input: facts({ status: 'REJECTED', reject_reason_code: 'NEGATIVE_BALANCE' }),
    override: { title_override: null, body_override: '抵扣说明：{reason}' },
    title: '提现未通过',
    body: '抵扣说明：有订单被扣回，冻结金额已用于抵扣',
  },
  {
    label: 'WD_FAILED 未命中映射覆盖正文仍代入兜底句',
    input: facts({ status: 'FAILED', fail_code: 'BALANCE_IS_NOT_ENOUGH' }),
    override: { title_override: '打款失败', body_override: '失败：{reason}；{amount}' },
    title: '打款失败',
    body: '失败：收款渠道未能完成这笔转账；¥10',
  },
  {
    label: '两项覆盖都为空回退包内默认',
    input: facts({ status: 'REJECTED', reject_reason_code: 'RISK_SUSPECT' }),
    override: { title_override: null, body_override: null },
    title: '提现未通过',
    body: '提现未通过：账户存在异常，需要核实，请联系客服，¥10 已退回余额',
  },
])('[AC-B1-12u#9] 标题与正文分别覆盖、分别回退：$label', ({ input, override, title, body }) => {
  expect(renderWithdrawalResultMessage(input, override)).toMatchObject({
    category: 'service',
    title,
    body,
  });
});
