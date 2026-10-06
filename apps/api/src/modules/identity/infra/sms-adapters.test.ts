import { expect, it, vi } from 'vitest';
import { createFakeSmsSender, createSmsSender, smsCredentialEnvNames } from './fake-sms.ts';
import { SMS_HMAC_CONTEXT, createSmsHmac } from './sms-hmac.ts';

const message = {
  app_id: 'couli',
  phone: '13912345678',
  purpose: 'login' as const,
  code: '042019',
};

it('[BR-ID-05] with a keyring the store hash is the blind index under its own context', () => {
  const blindIndex = vi.fn((value: string, context: string) => `bi(${context}|${value})`);
  const hmac = createSmsHmac('prod', { blindIndex });
  expect(hmac('phone:13912345678')).toBe(`bi(${SMS_HMAC_CONTEXT}|phone:13912345678)`);
  expect(SMS_HMAC_CONTEXT).toMatch(/^[\x21-\x7e]{1,200}$/);
});

it('[BR-ID-05] without a keyring local / test use a random per-process key; staging / prod refuse', () => {
  for (const env of ['local', 'test'] as const) {
    const one = createSmsHmac(env, undefined);
    const two = createSmsHmac(env, undefined);
    expect(one('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(one('x')).toBe(one('x'));
    expect(one('x')).not.toBe(two('x'));
  }
  for (const env of ['staging', 'prod'] as const) {
    expect(() => createSmsHmac(env, undefined)).toThrow(/keyring/);
  }
});

it('[BR-ID-05] the entry sender is the fake in local / test and rejects everything elsewhere until the provider adapter lands', async () => {
  for (const env of ['local', 'test']) {
    const sender = createSmsSender(env) as ReturnType<typeof createFakeSmsSender>;
    expect(await sender.send(message)).toBe('accepted');
    expect(sender.outbox()).toEqual([message]);
  }
  for (const env of ['staging', 'prod']) {
    expect(await createSmsSender(env).send(message)).toBe('rejected');
  }
});

it('[BR-ID-05] the fake keeps queued outcomes in order, copies messages and refuses an unknown outcome', async () => {
  const sender = createFakeSmsSender('test');
  sender.enqueueResult('unknown');
  sender.enqueueResult('rejected');
  const mutable = { ...message };
  expect(await sender.send(mutable)).toBe('unknown');
  expect(await sender.send(message)).toBe('rejected');
  expect(await sender.send(message)).toBe('accepted');
  mutable.code = '000000';
  expect(sender.outbox()).toEqual([message, message]);
  expect(Object.isFrozen(sender.outbox())).toBe(true);
  expect(() => sender.enqueueResult('lost' as never)).toThrow(TypeError);
});

it('[BR-ID-05] the SMS credential names are the SMS_-prefixed names loadConfig refuses', () => {
  expect(smsCredentialEnvNames()).toEqual([
    'SMS_ALIYUN_ACCESS_KEY_ID',
    'SMS_ALIYUN_ACCESS_KEY_SECRET',
  ]);
});
