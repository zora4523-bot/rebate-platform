import { expect, it } from 'vitest';
import { errorCodes } from '../../../../packages/contracts-ts/src/error-codes.gen.ts';
import { at, list, object, payValues, yaml } from './kit.ts';

// data 的 null 沿用 error-codes.yaml 的既有约定：该字段不在码表枚举取值。
const expectedCodes = [
  {
    code: 30901,
    http: 422,
    retry: '否',
    retry_kind: 'never',
    data: { reason: payValues.pay_unavailable_reason },
    sources: ['BR-PAY-01'],
    action: '仅提示，不显示支付入口；文案见 BR-TEXT-14 error.30901',
  },
  {
    code: 30902,
    http: 409,
    retry: '否',
    retry_kind: 'never',
    data: { pay_order_id: null },
    sources: ['BR-PAY-02'],
    action: '打开该支付单的结果页',
  },
  {
    code: 50306,
    http: 503,
    retry: '是',
    retry_kind: 'later',
    data: { pay_channel: payValues.pay_channel },
    sources: ['BR-PAY-03'],
    action: '提示稍后再试或换一种支付方式；可用同一支付单重新取调起参数',
  },
];

function sourceCode(code: number): Record<string, unknown> {
  const codes = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  const matches = codes.filter((entry) => entry['code'] === code);
  expect(matches, `错误码 ${code} 必须唯一登记`).toHaveLength(1);
  return object(matches[0]);
}

it.each(expectedCodes)(
  '[AC-CT-21b#6] 源错误码 $code 的 HTTP、重试、data、来源和客户端动作',
  ({ code, ...expected }) => {
    const actual = sourceCode(code);
    expect(actual).toMatchObject(expected);
    expect(actual['data']).toEqual(expected.data);
    expect(actual['sources']).toEqual(expected.sources);
    expect(actual['retry_kind_by_reason'] ?? {}).toEqual({});
    expect(actual['http_also'] ?? []).toEqual([]);
    expect(actual['deprecated'] ?? false).toBe(false);
    expect(actual['phase'] ?? null).toBeNull();
  },
);

it.each(expectedCodes)(
  '[AC-CT-21b#7] 生成错误码 $code 保留收款 data 形状与处理语义',
  ({ code, ...expected }) => {
    const actual = at(errorCodes, String(code));
    expect(actual).toMatchObject({
      ...expected,
      retry_kind_by_reason: {},
      http_also: [],
      deprecated: false,
      phase: null,
    });
    expect(actual['data']).toEqual(expected.data);
    expect(actual['sources']).toEqual(expected.sources);
  },
);

it('[AC-CT-21b#8] 20902 的源契约及生成物均接受支付单和退款单并发冲突', () => {
  for (const actual of [sourceCode(20902), object(errorCodes[20902])]) {
    expect(at(actual, 'data')['resource']).toEqual(
      expect.arrayContaining(['pay_order', 'pay_refund']),
    );
    expect(actual).toMatchObject({ http: 409, retry_kind: 'after_action' });
  }
});
