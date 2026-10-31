// B1-03ze: POST /admin/v1/appeals (adminRegisterAppeal; CT-24r; BR-ID-36 细则「被拦截请求申诉」,
// 编排裁定 D10-158). Customer service registers an account, order or blocked_request appeal: the
// appellant is derived from the target (a differing user_id → 20001 [user_id]); reason is required
// (1–200 characters after trimming, audit only); an unknown, foreign or unappealable target →
// 20001 [target_id]; a processing appeal on the target (for a register-type request also on the
// same related phone) is returned, nothing created; the appeal count used up → 30418. A new appeal
// is processing, source admin, the caller as registrant, no handler; an account appeal sets the
// user's risk_state to appealing with prev_risk_state; audit appeal_register. source / registrant
// are observed through the answer and the detail only (columns of this task's migration).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  REASON,
  accountAppeal,
  appealOf,
  appealRow,
  at,
  auditsOf,
  blocked,
  blockedAppeal,
  instants,
  iso,
  member,
  noPersonalData,
  orderAppeal,
  refused,
  resolvedEvents,
  restricted,
  riskRow,
  setup,
  snapshot,
  voidedOrder,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const CONTENT = '我只是正常使用，请帮我核查。';

const body = (target_type: string, target_id: string, extra: Record<string, unknown> = {}) => ({
  target_type,
  target_id,
  content: CONTENT,
  reason: REASON,
  ...extra,
});

/** One audit appeal_register naming the appeal, by the caller, with the note and no phone. */
async function registeredAudit(
  s: Scenario,
  appealId: string,
  mentions: readonly string[],
  secrets: readonly (string | null)[],
) {
  const audits = await auditsOf(s, 'appeal_register');
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
  expect(String(audits[0]!.target)).toContain(appealId);
  const text = JSON.stringify(audits[0]);
  for (const part of [REASON, ...mentions]) expect(text).toContain(part);
  noPersonalData(audits, secrets);
}

it.each(['banned', 'frozen'] as const)(
  '[AC-B1-03ze#60] 代登记 %s 账户的申诉：处理中、来源 admin、登记人为调用者、无处理人；risk_state 置 appealing 并记申诉前状态；写审计',
  async (state) => {
    const s = await setup(h, { displayName: '客服小林' });
    const user = await member(s, { state: null });
    await restricted(s, user.id, state);
    const response = await s.register(body('account', user.id));
    const d = await appealOf(response);
    expect(d).toMatchObject({
      user: { user_id: user.id, phone_masked: user.masked },
      target_type: 'account',
      target_id: user.id,
      target_no: user.id,
      request_type: null,
      prev_risk_state: state,
      status: 'processing',
      handler_id: null,
      handler_name: null,
      content: CONTENT,
      risk_state: 'appealing',
      source: 'admin',
      registered_by: s.a.id,
      registered_by_name: '客服小林',
      claimed_at: null,
      closed_at: null,
      row_version: 0,
      revoke_permission: state === 'banned' ? 'risk.ban' : 'risk.freeze',
      blocked_request: null,
    });
    expect(iso(d.created_at)).toBe(s.f.clock.now().toISOString());
    expect(Date.parse(d.deadline_at)).toBeGreaterThan(Date.parse(d.created_at));
    expect(await appealRow(s, d.appeal_id)).toMatchObject({
      app_id: s.appId,
      user_id: user.id,
      target_type: 'account',
      target_id: user.id,
      request_type: null,
      prev_risk_state: state,
      status: 'processing',
      content: CONTENT,
      handler_id: null,
      closed_at: null,
      row_version: 0,
    });
    expect(await riskRow(s, user.id)).toMatchObject({ state: 'appealing' });
    expect(instants(await appealOf(await s.detail(d.appeal_id)))).toEqual(instants(d));
    await registeredAudit(s, d.appeal_id, [user.id], [user.phone, user.hmac]);
    // The registration note is audit-only: no column, not in the answer.
    expect(JSON.stringify(response.json())).not.toContain(REASON);
    expect(JSON.stringify(await appealRow(s, d.appeal_id))).not.toContain(REASON);
    expect(await resolvedEvents(s)).toEqual([]);
  },
);

it('[AC-B1-03ze#61] 代登记订单申诉：申诉人为订单所属用户，对象编号为子订单号，不改 risk_state', async () => {
  const s = await setup(h);
  const user = await member(s);
  const o = await voidedOrder(s, user);
  const riskBefore = await riskRow(s, user.id);
  const d = await appealOf(await s.register(body('order', o.order_id)));
  expect(d).toMatchObject({
    user: { user_id: user.id, phone_masked: user.masked },
    target_type: 'order',
    target_id: o.order_id,
    target_no: o.sub_order_id,
    prev_risk_state: null,
    status: 'processing',
    handler_id: null,
    risk_state: 'normal',
    source: 'admin',
    registered_by: s.a.id,
    revoke_permission: null,
  });
  expect(await appealRow(s, d.appeal_id)).toMatchObject({
    user_id: user.id,
    target_type: 'order',
    target_id: o.order_id,
    status: 'processing',
  });
  expect(await riskRow(s, user.id)).toEqual(riskBefore);
  await registeredAudit(s, d.appeal_id, [o.order_id, user.id], [user.phone, user.hmac]);
});

it('[AC-B1-03ze#62] 代登记注册类被拦请求申诉（无账号）：无申诉人与风控状态，附被拦请求，审计无手机号明文与 HMAC', async () => {
  const s = await setup(h);
  const b = await blocked(s, { request_type: 'register', blocked_at: at(-2 * DAY) });
  const d = await appealOf(await s.register(body('blocked_request', b.id)));
  expect(d).toMatchObject({
    user: null,
    target_type: 'blocked_request',
    target_id: b.id,
    target_no: b.id,
    request_type: 'register',
    prev_risk_state: null,
    status: 'processing',
    risk_state: null,
    source: 'admin',
    registered_by: s.a.id,
    revoke_permission: 'risk.blocklist',
  });
  expect(d.blocked_request).toMatchObject({
    blocked_request_id: b.id,
    request_type: 'register',
    phone_masked: b.masked,
    processing_appeal_id: d.appeal_id,
  });
  expect(await appealRow(s, d.appeal_id)).toMatchObject({
    user_id: null,
    target_type: 'blocked_request',
    target_id: b.id,
    request_type: 'register',
    related_phone_hmac: b.phone_hmac,
    status: 'processing',
  });
  await registeredAudit(s, d.appeal_id, [b.id], [b.phone, ...b.secrets]);
  noPersonalData(d, [b.phone, ...b.secrets]);
});

it('[AC-B1-03ze#63] 代登记提现类被拦请求申诉：申诉人为被拦请求的用户，不改 risk_state', async () => {
  const s = await setup(h);
  const user = await member(s);
  const b = await blocked(s, {
    request_type: 'withdraw',
    user,
    rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
    blocked_at: at(-DAY),
  });
  const riskBefore = await riskRow(s, user.id);
  const d = await appealOf(await s.register(body('blocked_request', b.id, { user_id: user.id })));
  expect(d).toMatchObject({
    user: { user_id: user.id, phone_masked: user.masked },
    request_type: 'withdraw',
    risk_state: 'normal',
    source: 'admin',
    registered_by: s.a.id,
    revoke_permission: null,
  });
  expect(await appealRow(s, d.appeal_id)).toMatchObject({
    user_id: user.id,
    request_type: 'withdraw',
    target_id: b.id,
  });
  expect(await riskRow(s, user.id)).toEqual(riskBefore);
});

it.each<[string, unknown]>([
  ['缺失', undefined],
  ['为空', ''],
  ['只有空白', ' \t '],
  ['201 字', '因'.repeat(201)],
  ['非字符串', 1],
])('[AC-B1-03ze#64] 登记原因%s → 20001 [reason]，什么都不写', async (_label, reason) => {
  const s = await setup(h);
  const user = await member(s, { state: null });
  await restricted(s, user.id, 'banned');
  const before = await snapshot(s);
  const request: Record<string, unknown> = body('account', user.id);
  if (reason === undefined) delete request.reason;
  else request.reason = reason;
  await refused(await s.register(request), 20001, { fields: ['reason'] });
  expect(await snapshot(s)).toEqual(before);
});

it.each([
  ['因', '因'],
  [`  ${'因'.repeat(200)}  `, '因'.repeat(200)],
])('[AC-B1-03ze#65] 登记原因边界 %j 可登记，审计记去空白后的原因', async (reason, trimmed) => {
  const s = await setup(h);
  const b = await blocked(s, { request_type: 'register', blocked_at: at(-DAY) });
  await appealOf(await s.register(body('blocked_request', b.id, { reason })));
  const audits = await auditsOf(s, 'appeal_register');
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits[0])).toContain(JSON.stringify(trimmed));
});

it('[AC-B1-03ze#66] user_id 与服务端由对象推出的申诉人不符 → 20001 [user_id]；相符可登记', async () => {
  const s = await setup(h);
  const banned = await member(s, { state: null });
  await restricted(s, banned.id, 'banned');
  const owner = await member(s);
  const someone = await member(s);
  const o = await voidedOrder(s, owner);
  const register = await blocked(s, { request_type: 'register', blocked_at: at(-DAY) });
  const before = await snapshot(s);
  for (const request of [
    body('account', banned.id, { user_id: someone.id }),
    body('order', o.order_id, { user_id: someone.id }),
    body('blocked_request', register.id, { user_id: someone.id }),
  ]) {
    await refused(await s.register(request), 20001, { fields: ['user_id'] });
  }
  expect(await snapshot(s)).toEqual(before);
  const d = await appealOf(await s.register(body('account', banned.id, { user_id: banned.id })));
  expect(d.user?.user_id).toBe(banned.id);
});

it('[AC-B1-03ze#67] 未知、别的应用、不可申诉的对象 → 20001 [target_id]，什么都不写', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const normal = await member(s);
  const foreignUser = await member(other, { state: null });
  await restricted(other, foreignUser.id, 'banned');
  const foreignOrder = await voidedOrder(other, await member(other));
  const foreignBlocked = await blocked(other, { request_type: 'register', blocked_at: at(-DAY) });
  const owner = await member(s);
  const o = await voidedOrder(s, owner);
  const before = await snapshot(s);
  const otherBefore = await snapshot(other);
  for (const request of [
    body('account', randomUUID()),
    body('account', normal.id),
    body('account', foreignUser.id),
    body('order', randomUUID()),
    body('order', foreignOrder.order_id),
    body('order', owner.id),
    body('blocked_request', randomUUID()),
    body('blocked_request', foreignBlocked.id),
    // An order hit is not a request blocked with 44001.
    body('blocked_request', o.order_id),
  ]) {
    await refused(await s.register(request, { 'x-app-id': other.appId }), 20001, {
      fields: ['target_id'],
    });
  }
  expect(await snapshot(s)).toEqual(before);
  expect(await snapshot(other)).toEqual(otherBefore);
});

it('[AC-B1-03ze#68] 同一对象已有处理中的申诉：返回原申诉，不新建、不改状态、不写审计', async () => {
  const s = await setup(h);
  const appellant = await member(s, { state: 'appealing' });
  const account = await accountAppeal(s, appellant, 'banned');
  const owner = await member(s);
  const o = await voidedOrder(s, owner);
  const order = await orderAppeal(s, owner, o);
  const withdrawer = await member(s);
  const w = await blocked(s, { request_type: 'withdraw', user: withdrawer, blocked_at: at(-DAY) });
  const withdrawal = await blockedAppeal(s, w);
  const before = await snapshot(s);
  for (const [request, existing] of [
    [body('account', appellant.id), account],
    [body('order', o.order_id), order],
    [body('blocked_request', w.id), withdrawal],
  ] as const) {
    const d = await appealOf(await s.register(request));
    expect(d).toMatchObject({
      appeal_id: existing.id,
      status: 'processing',
      source: 'app',
      registered_by: null,
      content: existing.content,
    });
  }
  expect(await snapshot(s)).toEqual(before);
  expect(await auditsOf(s, 'appeal_register')).toEqual([]);
});

it('[AC-B1-03ze#69] 注册类被拦请求：同一关联手机号已有处理中的申诉 → 返回那张申诉', async () => {
  const s = await setup(h);
  const first = await blocked(s, { request_type: 'register', blocked_at: at(-2 * DAY) });
  const again = await blocked(s, {
    request_type: 'register',
    phone: first.phone,
    blocked_at: at(-DAY),
  });
  const existing = await blockedAppeal(s, first);
  const before = await snapshot(s);
  const d = await appealOf(await s.register(body('blocked_request', again.id)));
  expect(d.appeal_id).toBe(existing.id);
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03ze#70] 同一处罚的申诉次数用完（已维持 3 次）→ 30418，什么都不写；维持 2 次时仍可登记第 3 次', async () => {
  const s = await setup(h);
  const penalty = at(-20 * DAY);
  const usedUp = await member(s, { state: null });
  const third = await member(s, { state: null });
  for (const [user, count] of [
    [usedUp, 3],
    [third, 2],
  ] as const) {
    await restricted(s, user.id, 'banned', penalty);
    for (let n = 0; n < count; n += 1) {
      await accountAppeal(s, user, 'banned', {
        status: 'upheld',
        penalty_started_at: penalty,
        created_at: at(-(15 - 3 * n) * DAY),
      });
    }
  }
  const before = await snapshot(s);
  await refused(await s.register(body('account', usedUp.id)), 30418);
  expect(await snapshot(s)).toEqual(before);
  const d = await appealOf(await s.register(body('account', third.id)));
  expect(d).toMatchObject({ status: 'processing', source: 'admin', risk_state: 'appealing' });
});

it('[AC-B1-03ze#71] 同一登记重放（带同一 Idempotency-Key 也一样）返回同一申诉，只建一张、只写一条审计', async () => {
  const s = await setup(h);
  const user = await member(s, { state: null });
  await restricted(s, user.id, 'frozen');
  const key = { 'idempotency-key': randomUUID() };
  const first = await appealOf(await s.register(body('account', user.id), key));
  const after = await snapshot(s);
  const replays: Record<string, string>[] = [key, {}];
  for (const headers of replays) {
    const d = await appealOf(await s.register(body('account', user.id), headers));
    expect(d.appeal_id).toBe(first.appeal_id);
    expect(d.source).toBe('admin');
  }
  expect(await snapshot(s)).toEqual(after);
  expect(await auditsOf(s, 'appeal_register')).toHaveLength(1);
  expect(after.appeals.filter((row) => row.target_id === user.id)).toHaveLength(1);
});
