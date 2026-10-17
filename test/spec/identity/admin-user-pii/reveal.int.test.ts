// BR-ID-33 + CT-02j + task §9.2: real entry/guard/crypto/audit path, never a probe endpoint.
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  AUDIT_PORT,
  type AuditPort,
} from '../../../../apps/api/src/modules/platform/audit/port.ts';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import { lastCode, ok, SEND, STEP, type Grant } from '../../admin/step-up/kit.ts';
import {
  REASON,
  assertAudit,
  audits,
  member,
  mounted,
  noPlaintext,
  rejected,
  reveal,
  setup,
  stepUp,
  success,
  user,
} from './kit.ts';
import { contract, REVEAL } from './schema.ts';

const h = useHarness();

it.each([
  { permissions: [] },
  { permissions: ['user.list'] },
  { permissions: ['user.lookup'] },
  { permissions: ['pii.reveal_identity'] },
])('[AC-F1-07a#5] 非超管仅有 $permissions 权限不能 reveal（10403）', async ({ permissions }) => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const m = await member(h, f, permissions);
  const token = await stepUp(f, m.who, m.token);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { token: m.token, stepUp: token });
  await rejected(response, 10403, { reason: 'admin_permission_denied' });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});

it('[AC-F1-07a#6] 无后台登录身份不能查看明文', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { token: null });
  await rejected(response, 10001);
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});

it.each([true, false])(
  '[AC-F1-07a#7] 超管=%s 也必须提供有效 totp 令牌，缺失或无效为 10003 tier=totp',
  async (isSuper) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const m = isSuper ? { token: f.token } : await member(h, f, ['pii.reveal_phone']);
    const before = await audits(h, f);
    for (const extra of [{}, { stepUp: 'invalid-token' }]) {
      const response = await reveal(f, target.id, { token: m.token, ...extra });
      await rejected(response, 10003, { tier: 'totp' });
      noPlaintext(f, target, response);
    }
    expect(await audits(h, f)).toEqual(before);
  },
);

it.each([true, false])(
  '[AC-F1-07a#8] 超管=%s：从真实密文解出手机号，成功前逐次审计，响应 no-store',
  async (isSuper) => {
    const f = await setup(h);
    const target = await user(h, f.appId);
    const m = isSuper ? { who: f.actor, token: f.token } : await member(h, f, ['pii.reveal_phone']);
    const token = await stepUp(f, m.who, m.token);
    const before = await audits(h, f);
    await success(await reveal(f, target.id, { token: m.token, stepUp: token }), target);
    const after = await audits(h, f);
    const added = after.filter((row) => !before.some((old) => old.id === row.id));
    expect(added).toHaveLength(1);
    assertAudit(added[0]!, f, m.who, target);
    noPlaintext(f, target);
    const stored = await h.db
      .selectFrom('users')
      .select(['phone_cipher', 'phone_hmac'])
      .where('id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ phone_cipher: target.cipher, phone_hmac: target.hmac });
  },
);

it('[AC-F1-07a#9] totp 令牌成功后不可复用；新令牌的相同请求仍各记一条审计', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const first = await stepUp(f);
  await success(await reveal(f, target.id, { stepUp: first }), target);
  const afterFirst = await audits(h, f);
  await rejected(await reveal(f, target.id, { stepUp: first }), 10003, { tier: 'totp' });
  expect(await audits(h, f)).toEqual(afterFirst);
  const second = await stepUp(f);
  await success(await reveal(f, target.id, { stepUp: second }), target);
  const rows = (await audits(h, f)).filter((row) => row.action === 'user_pii_reveal');
  expect(rows).toHaveLength(2);
  expect(rows[0]!.id).not.toBe(rows[1]!.id);
  assertAudit(rows[1]!, f, f.actor, target);
  noPlaintext(f, target);
});

it('[AC-F1-07a#10] 同一令牌并发请求最多一次返回明文，且只有一条查看审计', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await stepUp(f);
  const responses = await Promise.all([
    reveal(f, target.id, { stepUp: token }),
    reveal(f, target.id, { stepUp: token }),
  ]);
  expect(responses.map((r) => r.json().code).sort((a, b) => a - b)).toEqual([0, 10003]);
  for (const response of responses) {
    if (response.json().code === 0) await success(response, target);
    else await rejected(response, 10003, { tier: 'totp' });
  }
  const rows = (await audits(h, f)).filter((row) => row.action === 'user_pii_reveal');
  expect(rows).toHaveLength(1);
  assertAudit(rows[0]!, f, f.actor, target);
});

it.each([
  { reason: REASON },
  { field: 'identity', reason: REASON },
  { field: 'id_no', reason: REASON },
  { field: 'name', reason: REASON },
  { field: 'payout_account', reason: REASON },
  { field: null, reason: REASON },
])('[AC-F1-07a#11] field 仅接受 phone，非法值 %j 返回 20001 [field]', async (body) => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await stepUp(f);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { stepUp: token, body });
  await rejected(response, 20001, { fields: ['field'] });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});

it.each([
  { field: 'phone' },
  { field: 'phone', reason: '' },
  { field: 'phone', reason: '核'.repeat(201) },
  { field: 'phone', reason: null },
  { field: 'phone', reason: 123 },
])('[AC-F1-07a#12] reason 必填且长度 1–200，非法输入返回 20001 [reason]：%j', async (body) => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await stepUp(f);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { stepUp: token, body });
  await rejected(response, 20001, { fields: ['reason'] });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});

it.each([1, 200])('[AC-F1-07a#13] reason 长度 %i 为合法边界并原样进入审计', async (length) => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const reason = '核'.repeat(length);
  await success(
    await reveal(f, target.id, { stepUp: await stepUp(f), body: { field: 'phone', reason } }),
    target,
  );
  const rows = (await audits(h, f)).filter((row) => row.action === 'user_pii_reveal');
  expect(rows).toHaveLength(1);
  assertAudit(rows[0]!, f, f.actor, target, reason);
});

it('[AC-F1-07a#14] 未知 user_id 返回 20001 [user_id] 且不审计', async () => {
  const f = await setup(h);
  // Keep a real local user present: a reader that forgets the user_id filter must fail.
  const existing = await user(h, f.appId);
  const token = await stepUp(f);
  const before = await audits(h, f);
  const response = await reveal(f, randomUUID(), { stepUp: token });
  await rejected(response, 20001, { fields: ['user_id'] });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, existing, response);
});

it('[AC-F1-07a#15] 超管也不能跨 app 查看，客户端 X-App-Id 不能改变后台身份范围', async () => {
  const f = await setup(h);
  const otherApp = `foreign-${randomUUID()}`;
  const target = await user(h, otherApp);
  const token = await stepUp(f);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, {
    stepUp: token,
    headers: { 'x-app-id': otherApp },
  });
  await rejected(response, 20001, { fields: ['user_id'] });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});

it('[AC-F1-07a#16] 未绑手机号返回 20001 [field]，不写任何查看审计', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId, false);
  const token = await stepUp(f);
  const before = await audits(h, f);
  await rejected(await reveal(f, target.id, { stepUp: token }), 20001, { fields: ['field'] });
  expect(await audits(h, f)).toEqual(before);
});

it('[AC-F1-07a#17] 审计失败返回 50001，不返回明文，不在日志泄露', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await stepUp(f);
  const before = await audits(h, f);
  const port = f.app.get<AuditPort>(AUDIT_PORT);
  const append = port.append.bind(port);
  const spy = vi.spyOn(port, 'append').mockImplementation(async (input) => {
    if (input.action === 'user_pii_reveal') throw new Error('synthetic audit failure');
    await append(input);
  });
  try {
    const response = await reveal(f, target.id, { stepUp: token });
    await rejected(response, 50001);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'user_pii_reveal' }));
    expect(await audits(h, f)).toEqual(before);
    noPlaintext(f, target, response);
  } finally {
    spy.mockRestore();
  }
});

it('[AC-F1-07a#18] 审计尚未完成时请求不能返回，审计端口输入本身也不含明文', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  const token = await stepUp(f);
  const port = f.app.get<AuditPort>(AUDIT_PORT);
  const append = port.append.bind(port);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const spy = vi.spyOn(port, 'append').mockImplementation(async (input) => {
    if (input.action === 'user_pii_reveal') {
      entered.resolve();
      await release.promise;
    }
    await append(input);
  });
  let completed = false;
  const request = Promise.resolve(reveal(f, target.id, { stepUp: token })).then((response) => {
    completed = true;
    return response;
  });
  try {
    expect(
      await Promise.race([entered.promise.then(() => 'audit'), request.then(() => 'response')]),
    ).toBe('audit');
    await setImmediate();
    expect(completed).toBe(false);
    const calls = spy.mock.calls.filter(([input]) => input.action === 'user_pii_reveal');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain(target.phone!);
    expect(JSON.stringify(calls)).not.toMatch(/"(?:value|phone|phone_cipher|phone_hmac)"\s*:/);
    release.resolve();
    await success(await request, target);
    const rows = (await audits(h, f)).filter((row) => row.action === 'user_pii_reveal');
    expect(rows).toHaveLength(1);
    assertAudit(rows[0]!, f, f.actor, target);
  } finally {
    release.resolve();
    await request;
    spy.mockRestore();
  }
});

it('[AC-F1-07a#19] 损坏的手机号密文不能被当作明文返回', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  await h.db
    .updateTable('users')
    .set({ phone_cipher: Buffer.from('broken-envelope') })
    .where('id', '=', target.id)
    .execute();
  const token = await stepUp(f);
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { stepUp: token });
  await rejected(response, 50001);
  expect(await audits(h, f)).toEqual(before);
  expect(JSON.stringify(response.json())).not.toContain('broken-envelope');
  noPlaintext(f, target, response);
});

it('[AC-F1-07a#20] reveal 只挂 admin 入口，契约去掉 planned', async () => {
  const f = await setup(h);
  expect(mounted(f.app)).toBe(true);
  for (const entry of ['api', 'stream'] as const) {
    const other = await fixture(h, { entry });
    expect(mounted(other.app)).toBe(false);
  }
  expect((await contract()).paths[REVEAL]!.post['x-implementation']).not.toBe('planned');
});

it('[AC-F1-07a#21] 有效 sms 级别令牌不能代替 totp 动态码令牌', async () => {
  const f = await setup(h);
  const target = await user(h, f.appId);
  await h.db
    .updateTable('admin_users')
    .set({
      verify_phone_cipher: Buffer.from(
        h.fields.encrypt(target.phone!, `admin_users.verify_phone:${f.appId}:${f.actor.id}`),
      ),
      verify_phone_hmac: h.fields.blindIndex(target.phone!, 'admin_users.verify_phone'),
      verify_phone_set_at: f.clock.now(),
    })
    .where('id', '=', f.actor.id)
    .execute();
  const headers = { authorization: `Bearer ${f.token}` };
  await ok(await f.post('/step-up/sms-codes', {}, headers), SEND);
  const grant = await ok<Grant>(
    await f.post('/step-up', { tier: 'sms', code: lastCode(f) }, headers),
    STEP,
  );
  const before = await audits(h, f);
  const response = await reveal(f, target.id, { stepUp: grant.step_up_token });
  await rejected(response, 10003, { tier: 'totp' });
  expect(await audits(h, f)).toEqual(before);
  noPlaintext(f, target, response);
});
