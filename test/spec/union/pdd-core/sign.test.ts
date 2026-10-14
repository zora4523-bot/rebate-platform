import { expect, it } from 'vitest';
import { signPddParameters } from '../../../../apps/api/src/modules/union/infra/pdd/sign.ts';
import { md5, secret } from './kit.ts';

it('[AC-B1-04g-SIGN#1] matches the official MD5 example exactly', () => {
  expect(
    signPddParameters(
      {
        access_token: 'asd78172s8ds9a921j9qqwda12312w1w21211',
        client_id: '1',
        data_type: 'XML',
        order_status: '1',
        page: '1',
        page_size: '10',
        timestamp: '1480411125',
        type: 'pdd.order.number.list.get',
      },
      secret,
    ),
  ).toBe('E4DE3ED21002510DED352819E7AE6775');
});

it('[AC-B1-04g-SIGN#2] sorts ASCII names, ignores sign and preserves UTF-8 without URL encoding', () => {
  const parameters = Object.freeze({
    z: '汉字 &+=',
    a: 0,
    _: false,
    Z: 'last',
    A: 'first',
    sign: 'old-sign',
  });
  const signed = signPddParameters(parameters, secret);
  expect(signed).toBe(md5('testSecretAfirstZlast_falsea0z汉字 &+=testSecret'));
  expect(signPddParameters({ A: 'first', Z: 'last', _: false, a: 0, z: '汉字 &+=' }, secret)).toBe(
    signed,
  );
  expect(parameters.sign).toBe('old-sign');
});

it('[AC-B1-04g-SIGN#3] concatenates names and values without separators and wraps both ends', () => {
  expect(signPddParameters({ b: '2', a: '1' }, secret)).toBe(md5('testSecreta1b2testSecret'));
  expect(signPddParameters({}, secret)).toBe(md5('testSecrettestSecret'));
  expect(signPddParameters({ b: '3', a: '1' }, secret)).not.toBe(
    signPddParameters({ a: '1', b: '2' }, secret),
  );
});

it('[AC-B1-04g-SIGN#4] structured values sign as compact JSON and match their submitted string form', () => {
  const goods = Object.freeze(['例子', 'a&b']);
  const range = Object.freeze({ min: 0, max: 10 });
  const parameters = Object.freeze({ goods_sign_list: goods, range_list: range });
  const expected = md5(
    'testSecretgoods_sign_list["例子","a&b"]range_list{"min":0,"max":10}testSecret',
  );
  expect(signPddParameters(parameters, secret)).toBe(expected);
  expect(
    signPddParameters(
      { goods_sign_list: JSON.stringify(goods), range_list: JSON.stringify(range) },
      secret,
    ),
  ).toBe(expected);
  expect(parameters).toEqual({ goods_sign_list: ['例子', 'a&b'], range_list: { min: 0, max: 10 } });
});
