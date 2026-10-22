import { expect, it } from 'vitest';
import { errorCodes } from '../../../../packages/contracts-ts/src/error-codes.gen.ts';
import { at, list, object, yaml } from './kit.ts';

// 任务书 §9.1 已给定的中文说明；退款原因的待确认直译不在这里锁死。
const labels = {
  pay_channel: { wechat_pay: '微信支付（APP 支付）', alipay: '支付宝（App 支付）' },
  pay_order_status: { PENDING: '待支付', PAID: '已支付', CLOSED: '已关闭' },
  pay_refund_status: { PROCESSING: '处理中', SUCCESS: '成功', FAILED: '失败' },
  pay_refund_target_type: { pay_order: '支付单', pay_anomaly: '异常收款' },
  pay_query_attempt_kind: {
    query: '查询',
    close: '关单',
    refund: '退款',
    refund_query: '退款查询',
  },
  pay_ledger_type: {
    PAY_RECEIPT: '收款',
    PAY_REFUND: '退款',
    PAY_ANOMALY: '异常收款',
    PAY_FEE: '渠道手续费',
  },
};

it.each(Object.entries(labels))(
  '[AC-CT-21b#13] %s 的源契约中文说明符合指定含义',
  (name, expected) => {
    expect(at(yaml('contracts/enums/pay.yaml'), 'enums', name, 'values')).toEqual(expected);
  },
);

const meanings = [
  {
    code: 30901,
    meaning: '支付暂不可用（data.reason 取值见 contracts/enums/pay.yaml pay_unavailable_reason）',
  },
  { code: 30902, meaning: '该业务对象已有已支付的订单' },
  {
    code: 50306,
    meaning: '支付渠道暂不可用（向渠道下单失败或超时，支付单保持待支付）',
  },
];

it.each(meanings)('[AC-CT-21b#14] $code 的源契约及生成物保留指定错误含义', ({ code, meaning }) => {
  const matches = list(yaml('contracts/error-codes.yaml')['codes'])
    .map(object)
    .filter((entry) => entry['code'] === code);
  expect(matches, `错误码 ${code} 必须唯一登记`).toHaveLength(1);
  expect(object(matches[0])['meaning']).toBe(meaning);
  expect(at(errorCodes, String(code))['meaning']).toBe(meaning);
});
