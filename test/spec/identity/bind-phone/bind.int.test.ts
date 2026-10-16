// B1-20a: POST /v1/me/phone first binding (规划/04 §6.1; 08 BR-ID-05 / BR-ID-06 / BR-ID-08;
// orchestrator ruling §9.3 items 1, 2, 6, 8). Real AppModule over PG and Redis.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedBlock } from '../../risk/blocklist/kit.ts';
import { fullWidthPhone } from '../sms-codes/kit.ts';
import {
  PATH,
  PHONE_CONTEXT,
  bound,
  closeKit,
  envelope,
  fixture,
  occupied,
  openKit,
  quiet,
  type Kit,
} from './http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

it('[AC-B1-20a#1] 契约 bindPhone 已去掉 planned', () => {
  expect(kit.document.paths[PATH]!['post']!['x-implementation']).not.toBe('planned');
});

it('[AC-B1-20a#2] 首次绑定成功：两列按规范化号写入、密文非明文、验证码已核销', async () => {
  const f = await fixture(kit);
  const before = await f.user();
  const code = await f.send();
  bound(kit, await f.bind({ phone: f.number, code }));
  const after = await f.user();
  expect(after.phone_hmac).toBe(f.hmac());
  expect(Buffer.isBuffer(after.phone_cipher)).toBe(true);
  const cipher = after.phone_cipher!.toString('utf8');
  expect(cipher).not.toContain(f.number);
  expect(kit.crypto.decrypt(cipher, PHONE_CONTEXT)).toBe(f.number);
  expect(after).toMatchObject({
    status: before.status,
    register_method: before.register_method,
    parent_id: before.parent_id,
    invite_code: before.invite_code,
  });
  expect(await f.stillValid(code)).toBe(false);
  quiet(kit, f.number);
});

for (const [label, format] of [
  ['+86 与空格连字符', (n: string) => `+86 ${n.slice(0, 3)}-${n.slice(3, 7)} ${n.slice(7)}`],
  ['0086 前缀', (n: string) => `0086${n}`],
  ['全角数字与 86', (n: string) => fullWidthPhone(n)],
] as const) {
  it(`[AC-B1-20a#3] 手机号先规范化再核码与写入：${label}`, async () => {
    const f = await fixture(kit);
    const code = await f.send();
    bound(kit, await f.bind({ phone: format(f.number), code }));
    const after = await f.user();
    expect(after.phone_hmac).toBe(f.hmac());
    expect(kit.crypto.decrypt(after.phone_cipher!.toString('utf8'), PHONE_CONTEXT)).toBe(f.number);
  });
}

for (const invalid of ['12345678901', '', '+1 2025550123', '1391234567']) {
  it(`[AC-B1-20a#4] 规范化不通过 ${JSON.stringify(invalid)} → 20001 phone_invalid，不消费验证码`, async () => {
    const f = await fixture(kit);
    const code = await f.send();
    const before = await f.snapshot();
    const body = envelope(kit, await f.bind({ phone: invalid, code }), 20001);
    expect(body.data).toEqual({ fields: ['phone'], reason: 'phone_invalid' });
    expect(await f.snapshot()).toEqual(before);
    bound(kit, await f.bind({ phone: f.number, code }));
    expect((await f.user()).phone_hmac).toBe(f.hmac());
  });
}

it('[AC-B1-20a#5] 验证码错误 20002 不绑定，之后用正确码仍可绑定', async () => {
  const f = await fixture(kit);
  const code = await f.send();
  const before = await f.snapshot();
  envelope(kit, await f.bind({ phone: f.number, code: wrong(code) }), 20002);
  expect(await f.snapshot()).toEqual(before);
  bound(kit, await f.bind({ phone: f.number, code }));
  expect((await f.user()).phone_hmac).toBe(f.hmac());
});

for (const kind of ['never_sent', 'expired', 'login_purpose', 'other_number'] as const) {
  it(`[AC-B1-20a#6] 无可用 bind 验证码（${kind}）→ 20003 不绑定`, async () => {
    const f = await fixture(kit);
    let code = '123456';
    if (kind === 'expired') {
      code = await f.send();
      kit.clock.advanceMs(300_000);
    } else if (kind === 'login_purpose') {
      code = await f.send(f.number, 'login');
    } else if (kind === 'other_number') {
      code = await f.send(`138${f.number.slice(3)}`);
    }
    const before = await f.snapshot();
    envelope(kit, await f.bind({ phone: f.number, code }), 20003);
    expect(await f.snapshot()).toEqual(before);
  });
}

it('[AC-B1-20a#7] 目标号命中黑名单 → 44001，不绑定、验证码已核销、不记手机号', async () => {
  const f = await fixture(kit);
  const code = await f.send();
  await seedBlock(kit.suite.db, f.appId, 'phone', f.hmac(), kit.clock);
  const before = await f.snapshot();
  const body = envelope(kit, await f.bind({ phone: f.number, code }), 44001);
  if (body.data !== undefined) expect(Object.keys(body.data)).toEqual(['risk_msg_code']);
  expect(JSON.stringify(body)).not.toContain(f.number);
  expect(await f.snapshot()).toEqual(before);
  expect(await f.stillValid(code)).toBe(false);
  quiet(kit, f.number);
});

it('[AC-B1-20a#8] 目标号同时在黑名单且属于他人 → 44001 先于 30411', async () => {
  const f = await fixture(kit);
  const code = await f.send();
  await f.owner();
  await seedBlock(kit.suite.db, f.appId, 'phone', f.hmac(), kit.clock);
  const before = await f.snapshot();
  envelope(kit, await f.bind({ phone: f.number, code }), 44001);
  expect(await f.snapshot()).toEqual(before);
});

it('[AC-B1-20a#9] 目标号属于本 App 其他账号 → 30411 无 reason，两个账号的资料、绑定、会话都不动', async () => {
  // BR-ID-06 例：A 微信登录、已有 1 笔已归因订单，绑定 B 的号 → 30411，A、B 各自不动。
  const f = await fixture(kit, { method: 'wechat' });
  const orderId = await f.order();
  const other = await f.owner();
  const code = await f.send();
  const before = await f.snapshot();
  occupied(kit, await f.bind({ phone: f.number, code }));
  expect(await f.snapshot()).toEqual(before);
  const orders = await f.db
    .selectFrom('orders')
    .select(['order_id', 'user_id'])
    .where('app_id', '=', f.appId)
    .execute();
  expect(orders).toEqual([{ order_id: orderId, user_id: f.uid }]);
  expect((await f.user(other)).phone_hmac).toBe(f.hmac());
  expect((await f.user()).phone_hmac).toBeNull();
  expect(await f.stillValid(code)).toBe(false);
  quiet(kit, f.number);
});

it('[AC-B1-20a#10] 目标号属于注销冷静期 / 处理中（deleting）的账号 → 30411', async () => {
  const f = await fixture(kit, { method: 'sms' });
  await f.owner({ status: 'deleting' });
  const code = await f.send();
  const before = await f.snapshot();
  occupied(kit, await f.bind({ phone: f.number, code }));
  expect(await f.snapshot()).toEqual(before);
});

it('[AC-B1-20a#11] 目标号只属于已完成注销的账号 → 绑定成功，已注销行不动', async () => {
  const f = await fixture(kit, { method: 'sms' });
  const deleted = await f.owner({ status: 'deleted' });
  const before = await f.user(deleted);
  const code = await f.send();
  bound(kit, await f.bind({ phone: f.number, code }));
  expect((await f.user()).phone_hmac).toBe(f.hmac());
  expect(await f.user(deleted)).toEqual(before);
});

for (const [label, headers] of [
  ['不带 X-Step-Up-Token', {}],
  ['带无效 X-Step-Up-Token', { 'x-step-up-token': 'not-a-step-up-token' }],
] as const) {
  it(`[AC-B1-20a#12] 已绑手机的账号走更换分支 → 10003（${label}），不消费验证码、不写行`, async () => {
    const f = await fixture(kit, { bound: true });
    const code = await f.send();
    const before = await f.snapshot();
    envelope(kit, await f.bind({ phone: f.number, code }, { headers }), 10003);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.user()).phone_hmac).toBe(kit.crypto.blindIndex(f.own!, PHONE_CONTEXT));
    expect(await f.stillValid(code)).toBe(true);
  });
}

it('[AC-B1-20a#13] 同一幂等键重放返回原响应，不再核码、不再写', async () => {
  const f = await fixture(kit);
  const code = await f.send();
  const key = randomUUID();
  const first = await f.bind({ phone: f.number, code }, { key });
  bound(kit, first);
  const after = await f.snapshot();
  const second = await f.bind({ phone: f.number, code }, { key });
  bound(kit, second);
  expect(second.json<{ code: number; data: unknown }>()).toMatchObject({
    code: first.json<{ code: number }>().code,
    data: first.json<{ data: unknown }>().data,
  });
  expect(await f.snapshot()).toEqual(after);
});

it('[AC-B1-20a#14] 装配抽查：游客 10001、签名不符 10401，均不核码不写', async () => {
  const f = await fixture(kit);
  const code = await f.send();
  const before = await f.snapshot();
  envelope(kit, await f.bind({ phone: f.number, code }, { guest: true }), 10001);
  envelope(kit, await f.bind({ phone: f.number, code }, { badSign: true }), 10401);
  expect(await f.snapshot()).toEqual(before);
  expect(await f.stillValid(code)).toBe(true);
});

it('[AC-B1-20a#15] 装配抽查：低于最低支持版本 → 10405，不核码不写', async () => {
  const f = await fixture(kit, { minVersion: '2.0.0' });
  const code = await f.send();
  const before = await f.snapshot();
  envelope(
    kit,
    await f.bind({ phone: f.number, code }, { headers: { 'x-app-version': '1.9.9' } }),
    10405,
  );
  expect(await f.snapshot()).toEqual(before);
  expect(await f.stillValid(code)).toBe(true);
});

for (const [label, body] of [
  ['code 不是 6 位数字', (n: string) => ({ phone: n, code: '12345' })],
  ['缺 code', (n: string) => ({ phone: n })],
  ['多余字段 user_id', (n: string) => ({ phone: n, code: '123456', user_id: randomUUID() })],
] as const) {
  it(`[AC-B1-20a#16] 请求体按契约校验：${label} → 20001，不核码不写`, async () => {
    const f = await fixture(kit);
    const code = await f.send();
    const before = await f.snapshot();
    envelope(kit, await f.bind(body(f.number)), 20001);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.stillValid(code)).toBe(true);
  });
}
