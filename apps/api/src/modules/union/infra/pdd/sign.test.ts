import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { pddParameterText, signPddParameters } from './sign.ts';

// 官方文档示例值（testSecret 不是真实密钥）。
const secret = 'testSecret';

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

it('[AC-B1-04g-UNIT#1] 官方示例向量：签名等于 E4DE3ED21002510DED352819E7AE6775', () => {
  expect(
    signPddParameters(
      {
        type: 'pdd.order.number.list.get',
        timestamp: '1480411125',
        page_size: '10',
        page: '1',
        order_status: '1',
        data_type: 'XML',
        client_id: '1',
        access_token: 'asd78172s8ds9a921j9qqwda12312w1w21211',
      },
      secret,
    ),
  ).toBe('E4DE3ED21002510DED352819E7AE6775');
});

it('[AC-B1-04g-UNIT#2] sign 自身不参与签名，数字与布尔取字符串形式', () => {
  expect(signPddParameters({ sign: 'x', n: 10, b: true }, secret)).toBe(
    md5('testSecretbtruen10testSecret'),
  );
});

it('[AC-B1-04g-UNIT#3] 数组与对象按紧凑 JSON 参与签名', () => {
  expect(pddParameterText(['a', 1])).toBe('["a",1]');
  expect(pddParameterText({ k: 'v' })).toBe('{"k":"v"}');
  expect(pddParameterText('原样 &=')).toBe('原样 &=');
});
