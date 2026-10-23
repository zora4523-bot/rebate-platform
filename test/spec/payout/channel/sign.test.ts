import { constants, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  canonicalAlipayParams,
  signAlipayParams,
  verifyAlipayResponse,
} from '../../../../apps/api/src/modules/payout/infra/channels/alipay-sign.ts';
import { alipayKeys, appKeys, signNode } from './fixtures.ts';

const PARAMS = {
  version: '1.0',
  sign_type: 'RSA2',
  method: 'alipay.fund.trans.uni.transfer',
  biz_content: '{"out_biz_no":"wd_1","note":"测试 A&B=1"}',
  app_id: 'test_app',
};
const CANONICAL =
  'app_id=test_app&biz_content={"out_biz_no":"wd_1","note":"测试 A&B=1"}&method=alipay.fund.trans.uni.transfer&sign_type=RSA2&version=1.0';

it('[AC-B2-06b#13] canonical request sorts ASCII keys, drops empty values, and keeps original values without URL escaping', () => {
  expect(canonicalAlipayParams(PARAMS)).toBe(CANONICAL);
  expect(canonicalAlipayParams({ ...PARAMS, sign: 'not_part_of_the_signature' })).toBe(CANONICAL);
  expect(canonicalAlipayParams({ ...PARAMS, app_cert_sn: '', notify_url: '' })).toBe(CANONICAL);
  expect(canonicalAlipayParams({ z: '3', a: '2', Z: '1' })).toBe('Z=1&a=2&z=3');
});

it('[AC-B2-06b#14] RSA2 signature verifies independently with the application public key, SHA256 and PKCS1 v1.5', () => {
  const signature = signAlipayParams(PARAMS, appKeys().privateKey);
  expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(CANONICAL),
      {
        key: appKeys().publicKey,
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(signature, 'base64'),
    ),
  ).toBe(true);
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(`${CANONICAL}0`),
      appKeys().publicKey,
      Buffer.from(signature, 'base64'),
    ),
  ).toBe(false);
  expect(
    verify(
      'RSA-SHA256',
      Buffer.from(CANONICAL),
      alipayKeys().publicKey,
      Buffer.from(signature, 'base64'),
    ),
  ).toBe(false);
});

it('[AC-B2-06b#15] response verification uses the Alipay public key on the exact node bytes including whitespace and escapes', () => {
  const node = '{ "code" : "10000", "msg":"\\u6d4b\\u8bd5", "order_id":"synthetic" }';
  const signature = signNode(node);
  expect(verifyAlipayResponse(node, signature, alipayKeys().publicKey)).toBe(true);
  expect(
    verifyAlipayResponse(JSON.stringify(JSON.parse(node)), signature, alipayKeys().publicKey),
  ).toBe(false);
  expect(
    verifyAlipayResponse(node.replace('10000', '40004'), signature, alipayKeys().publicKey),
  ).toBe(false);
  // The application key pair is not the Alipay key pair: neither direction may verify.
  expect(verifyAlipayResponse(node, signature, appKeys().publicKey)).toBe(false);
  expect(
    verifyAlipayResponse(node, signNode(node, appKeys().privateKey), alipayKeys().publicKey),
  ).toBe(false);
});
