import { expect, it } from 'vitest';
import { createFakeTemplateSmsSender } from '../../../../apps/api/src/modules/notification/index.ts';
import {
  alertPhoneId,
  decodeAlertPhones,
  encodeAlertPhones,
} from '../../../../apps/api/src/modules/union/index.ts';
import { cryptoDouble, PHONE_CONTEXT, PHONES } from './kit.ts';

it('[AC-S1-64#40] 告警手机号整组加密并可解码，context 固定，配置不含明文', () => {
  const crypto = cryptoDouble();
  const encoded = encodeAlertPhones(crypto, PHONES);
  expect(crypto.encrypt).toHaveBeenCalledWith(JSON.stringify(PHONES), PHONE_CONTEXT);
  expect(encoded).toEqual({ cipher: expect.any(String) });
  expect(decodeAlertPhones(crypto, encoded)).toEqual([...PHONES]);
  expect(crypto.decrypt).toHaveBeenCalledWith(expect.any(String), PHONE_CONTEXT);
  for (const phone of PHONES) expect(JSON.stringify(encoded)).not.toContain(phone);
  expect(decodeAlertPhones(crypto, encodeAlertPhones(crypto, []))).toEqual([]);
});

it('[AC-S1-64#41] 号码 HMAC 先规范化，国家码/全角/空白不产生新身份，context 固定', () => {
  const crypto = cryptoDouble();
  const expected = crypto.blindIndex(PHONES[0], PHONE_CONTEXT);
  for (const phone of [
    PHONES[0],
    '+86 138-0013-8000',
    '008613800138000',
    '＋８６１３８００１３８０００',
  ]) {
    expect(alertPhoneId(crypto, phone)).toBe(expected);
  }
  expect(crypto.blindIndex).toHaveBeenLastCalledWith(PHONES[0], PHONE_CONTEXT);
  expect(alertPhoneId(crypto, PHONES[1])).not.toBe(expected);
  expect(() => alertPhoneId(crypto, '+1 1234567890')).toThrow();
});

for (const env of ['local', 'test']) {
  it(`[AC-S1-64#42] ${env} 假短信严格渲染两份 BR-TEXT-20 原文`, async () => {
    const sender = createFakeTemplateSmsSender(env);
    for (const platform_name of ['淘宝', '京东', '拼多多']) {
      await sender.send({
        appId: 'synthetic',
        phone: PHONES[0],
        template: 'UNION_AUTH_EXPIRING',
        params: { platform_name, expires_at: '2026-12-30 00:00' },
      });
      await sender.send({
        appId: 'synthetic',
        phone: PHONES[1],
        template: 'UNION_AUTH_EXPIRED',
        params: { platform_name, expires_at: '2026-12-30 00:00' },
      });
    }
    expect(sender.outbox().map((m) => m.text)).toEqual(
      ['淘宝', '京东', '拼多多'].flatMap((name) => [
        `【凑狸】你的${name}联盟授权将于2026-12-30 00:00到期，请登录后台重新授权，过期后新用户将无法下单。`,
        `【凑狸】你的${name}联盟授权已过期或失效，新用户暂时无法下单，请尽快登录后台重新授权。`,
      ]),
    );
    for (const message of sender.outbox()) {
      expect(message.text).not.toMatch(/^[【\[]?(淘宝|天猫|京东|拼多多|美团|阿里|支付宝)/);
      expect(message.text).not.toContain('官方');
    }
  });
}

it('[AC-S1-64#43] 假发送器只许 local/test，按排队的 accepted/rejected/unknown 返回', async () => {
  const sender = createFakeTemplateSmsSender('test');
  for (const result of ['rejected', 'unknown', 'accepted'] as const) sender.enqueueResult(result);
  const results = [];
  for (let i = 0; i < 3; i += 1)
    results.push(
      await sender.send({
        appId: 'synthetic',
        phone: PHONES[0],
        template: 'UNION_AUTH_EXPIRED',
        params: { platform_name: '淘宝' },
      }),
    );
  expect(results).toEqual(['rejected', 'unknown', 'accepted']);
  for (const env of ['prod', 'staging', 'development', '']) {
    expect(() => createFakeTemplateSmsSender(env)).toThrow();
  }
});
