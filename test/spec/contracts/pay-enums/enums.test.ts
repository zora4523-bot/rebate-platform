import { expect, it } from 'vitest';
import * as generated from '../../../../packages/contracts-ts/src/enums.gen.ts';
import { at, object, payValues, read, yaml } from './kit.ts';

const sources = {
  pay_channel: 'BR-PAY-01',
  pay_order_status: 'BR-PAY-02',
  pay_refund_status: 'BR-PAY-06',
  pay_ledger_type: 'BR-PAY-07',
  pay_refund_reason: 'BR-PAY-06',
  pay_refund_target_type: 'BR-PAY-06',
  pay_query_attempt_kind: '04',
  pay_unavailable_reason: 'BR-PAY-01',
};

it.each(Object.entries(payValues))(
  '[AC-CT-21b#1] pay.yaml 的 %s 取值、顺序和来源符合收款契约',
  (name, expected) => {
    const doc = yaml('contracts/enums/pay.yaml');
    expect(Object.keys(doc)).toEqual(['enums']);
    const catalog = at(doc, 'enums');
    expect(Object.keys(catalog).toSorted()).toEqual(Object.keys(payValues).toSorted());
    const definition = at(catalog, name);
    expect(Object.keys(at(definition, 'values'))).toEqual(expected);
    expect(definition['source']).toContain(sources[name as keyof typeof sources]);
    for (const label of Object.values(at(definition, 'values'))) {
      expect(label).toBeTypeOf('string');
      expect(label).toMatch(/\S/u);
    }
  },
);

it.each(Object.entries(payValues))(
  '[AC-CT-21b#2] %s 的命名导出及 enums 注册表均保留完整取值与顺序',
  (name, expected) => {
    expect(object(generated)[name]).toEqual(expected);
    expect(object(generated.enums)[name]).toEqual(expected);
  },
);

it('[AC-CT-21b#3] R4 两类收款差错进入源契约和生成枚举，来源含 BR-PAY-07', () => {
  const definition = at(yaml('contracts/enums/fund.yaml'), 'enums', 'recon_diff_type');
  expect(at(definition, 'values')).toMatchObject({
    pay_mismatch: '收款对账不一致（R4）',
    pay_anomaly: '收款异常（R4）',
  });
  expect(definition['source']).toContain('BR-PAY-07');
  expect(generated.recon_diff_type).toEqual(
    expect.arrayContaining(['pay_mismatch', 'pay_anomaly']),
  );
});

it('[AC-CT-21b#4] 收款凭证与用户流水严格隔离，不能混入 ledger_type', () => {
  const pay = Object.keys(
    at(yaml('contracts/enums/pay.yaml'), 'enums', 'pay_ledger_type', 'values'),
  );
  expect(pay).toEqual(payValues.pay_ledger_type);
  const user = Object.keys(at(yaml('contracts/enums/fund.yaml'), 'enums', 'ledger_type', 'values'));
  expect(user).toHaveLength(13);
  expect(pay.filter((value) => user.includes(value))).toEqual([]);
  expect(object(generated)['pay_ledger_type']).toEqual(payValues.pay_ledger_type);
  expect(generated.ledger_type).toHaveLength(13);
  expect(
    pay.filter((value) => (generated.ledger_type as readonly string[]).includes(value)),
  ).toEqual([]);
});

it('[AC-CT-21b#5] 契约文件表登记收款枚举 pay.yaml', () => {
  expect(read('contracts/README.md')).toMatch(/^\|[^\n]*pay\.yaml[^\n]*\|/m);
});
