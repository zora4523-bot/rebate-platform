import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from './kit.ts';
import { sdk, web } from './client.ts';
import { configure, scenario, snapshot, state } from './records.ts';
import { rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each([
  'nickname',
  'avatar',
  'account_name',
  'relation_id',
  'user_id',
  'device_id',
  'auth_app_refs',
])('[AC-B1-06h#8] 未定义字段 %s 返回 20001，state 原样', async (field) => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const before = await snapshot(f, c);
  await rejected(await c.post({ ...web(s.state), [field]: 'synthetic-injected-value' }), 20001);
  expect(f.exchange).not.toHaveBeenCalled();
  expect(await snapshot(f, c)).toEqual(before);
});

it.each([
  'mixed_web',
  'mixed_sdk',
  'missing_code',
  'missing_access_token',
  'missing_expires_in',
  'zero_expires_in',
  'unknown_method',
] as const)('[AC-B1-06h#8] %s 请求体不符合契约，不消费 state', async (kind) => {
  const f = use();
  const { c } = await scenario(f);
  await configure(f, c, ['sdk_token', 'web_code']);
  const s = await state(f, c, { auth_methods: ['sdk_token', 'web_code'] });
  let body: Record<string, unknown>;
  switch (kind) {
    case 'mixed_web':
      body = { ...sdk(s.state), ...web(s.state) };
      break;
    case 'mixed_sdk':
      body = { ...web(s.state), ...sdk(s.state) };
      break;
    case 'missing_code':
      body = { state: s.state, auth_method: 'web_code' };
      break;
    case 'missing_access_token':
      body = { state: s.state, auth_method: 'sdk_token', expires_in: 3600 };
      break;
    case 'missing_expires_in':
      body = { state: s.state, auth_method: 'sdk_token', access_token: 'synthetic' };
      break;
    case 'zero_expires_in':
      body = { ...sdk(s.state), expires_in: 0 };
      break;
    case 'unknown_method':
      body = { ...web(s.state), auth_method: 'unknown' };
      break;
  }
  const before = await snapshot(f, c);
  await rejected(await c.post(body), 20001);
  expect(f.exchange).not.toHaveBeenCalled();
  expect(await snapshot(f, c)).toEqual(before);
});

it.each(['jd', 'pdd'])('[AC-B1-06h#8] POST 不支持平台 %s，fields=[platform]', async (platform) => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const before = await snapshot(f, c);
  const response = await c.post(web(s.state), { platform });
  await rejected(response, 20001);
  expect(response.json()).toMatchObject({ data: { fields: ['platform'] } });
  expect(f.exchange).not.toHaveBeenCalled();
  expect(await snapshot(f, c)).toEqual(before);
});

it('[AC-B1-06h#12] 签名有效但无令牌返回 10001，不消费 state', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const before = await snapshot(f, c);
  await rejected(await c.post(web(s.state), { token: null }), 10001);
  expect(f.exchange).not.toHaveBeenCalled();
  expect(await snapshot(f, c)).toEqual(before);
});
