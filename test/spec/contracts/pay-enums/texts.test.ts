import { expect, it } from 'vitest';
import { payValues, texts } from './kit.ts';

const clientFile = 'contracts/texts.default.json';
const adminFile = 'contracts/texts.admin.default.json';
const errorTexts = [
  ['error.30901', '暂时无法支付，请稍后再试'],
  ['error.30902', '这笔订单已经支付过了'],
  ['error.50306', '支付服务繁忙，请稍后再试或换一种支付方式'],
];

it.each(errorTexts)('[AC-CT-21b#9] %s 默认文案与 08 原文逐字一致', (key, expected) => {
  expect(texts(clientFile)[key!]).toBe(expected);
});

it('[AC-CT-21b#10] 30901 的四种不可支付原因对用户统一提示，不暴露开关和端限制', () => {
  const dictionary = texts(clientFile);
  const expected = '暂时无法支付，请稍后再试';
  expect(dictionary['error.30901']).toBe(expected);
  for (const reason of payValues.pay_unavailable_reason) {
    expect(dictionary[`error.30901.${reason}`] ?? dictionary['error.30901']).toBe(expected);
  }
});

const adminLabels = {
  pay_channel: { wechat_pay: '微信支付（APP 支付）', alipay: '支付宝（App 支付）' },
  pay_order_status: { PENDING: '待支付', PAID: '已支付', CLOSED: '已关闭' },
  pay_refund_status: { PROCESSING: '处理中', SUCCESS: '成功', FAILED: '失败' },
  pay_refund_target_type: { pay_order: '支付单', pay_anomaly: '异常收款' },
};

it.each(Object.entries(adminLabels))(
  '[AC-CT-21b#11] 后台 %s 中文字典完整且不进入用户默认文案',
  (name, labels) => {
    const admin = texts(adminFile);
    const client = texts(clientFile);
    const prefix = `admin_dict.${name}.`;
    expect(
      Object.keys(admin)
        .filter((key) => key.startsWith(prefix))
        .toSorted(),
    ).toEqual(
      Object.keys(labels)
        .map((code) => `${prefix}${code}`)
        .toSorted(),
    );
    for (const [code, label] of Object.entries(labels)) {
      expect(admin[`${prefix}${code}`]).toBe(label);
    }
    expect(Object.keys(client).filter((key) => key.startsWith(prefix))).toEqual([]);
  },
);

it('[AC-CT-21b#12] 后台五个退款原因均有中文默认名，不锁死待确认的直译', () => {
  const admin = texts(adminFile);
  const prefix = 'admin_dict.pay_refund_reason.';
  expect(
    Object.keys(admin)
      .filter((key) => key.startsWith(prefix))
      .toSorted(),
  ).toEqual(payValues.pay_refund_reason.map((code) => `${prefix}${code}`).toSorted());
  // BR-PAY-06 只规定原因码；中文名是实现代理补全的默认，待财务 / 负责人确认。
  for (const code of payValues.pay_refund_reason) {
    expect(admin[`${prefix}${code}`]).toBeTypeOf('string');
    expect(admin[`${prefix}${code}`]).toMatch(/[\u3400-\u9fff]/u);
  }
  expect(Object.keys(texts(clientFile)).filter((key) => key.startsWith(prefix))).toEqual([]);
});
