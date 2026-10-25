// B1-27c · the user's unfinished request (contract adminCreateUserDataExport point 2; 08 BR-ID-40
// 细则「重新登记与登记人停用」; task §9 ② ⑤): a pending, running or ready request is returned with
// reused=true instead of creating one, whatever this call's channel facts say, with one audit record
// naming it. Exception: an undelivered wecom_session request whose registrant is disabled or no
// longer holds both user.data_export and pii.reveal_phone is set to failed now and a new request is
// created (retry_of the old one, its due_at kept). in_app_sms requests are never affected; a super
// admin holds every point. Concurrent registrations still leave one unfinished request.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  GENERATE,
  OPEN,
  PERMISSION,
  PII,
  QUEUE,
  audits,
  channelsOf,
  copiesOf,
  copy,
  copyRow,
  expectRequestAudit,
  inApp,
  jobs,
  member,
  ms,
  ok,
  queuedJobs,
  register,
  registrant,
  setup,
  stepUp,
  superAdmin,
  user,
  wecom,
  type Body,
  type CopyRow,
  type CopyStatus,
  type Delivery,
  type Registered,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** `data` is `original` returned as it is, with reused=true. */
function expectReturned(data: Registered, original: CopyRow) {
  expect(data).toMatchObject({
    export_id: original.id,
    user_id: original.user_id,
    delivery: original.delivery,
    status: original.status,
    requested_by: original.requested_by,
    retry_of: original.retry_of,
    failure_reason: original.failure_reason,
    reused: true,
  });
  expect(ms(data.created_at)).toBe(original.created_at.getTime());
  expect(ms(data.due_at)).toBe(original.due_at.getTime());
  expect(ms(data.generated_at)).toBe(ms(original.generated_at));
  expect(ms(data.delivered_at)).toBe(ms(original.delivered_at));
  expect(ms(data.expires_at)).toBe(ms(original.expires_at));
}

/** Nothing new: the original row unchanged, no job, one audit record naming the original. */
async function expectReusedOnly(
  s: Setup,
  target: User,
  original: CopyRow,
  audit: { admin: string; payload: Body },
) {
  expect(await copiesOf(s, target)).toEqual([original]);
  expect(jobs(s)).toEqual([]);
  expect(await queuedJobs(s)).toBe(0);
  const rows = await audits(s);
  expect(rows).toHaveLength(1);
  expectRequestAudit(s, rows[0], {
    admin: audit.admin,
    user: target,
    reason: String(audit.payload['reason']),
    channels: channelsOf(audit.payload),
    contains: [original.id],
  });
}

const OPEN_CASES = OPEN.flatMap((status) =>
  (['in_app_sms', 'wecom_session'] as const).map((delivery) => ({ status, delivery })),
);

it.each(OPEN_CASES)(
  '[AC-B1-27c#25] 已有 $status 的 $delivery 请求 → 返回原条 reused=true，不新建、不入队，记一条带原条 id 的审计',
  async ({ status, delivery }) => {
    const s = await setup(h);
    const target = await user(s);
    const by = await registrant(s);
    const original = await copy(s, target, { requestedBy: by.id, delivery, status });
    const data = await ok(await register(s, target.id, inApp()));
    expectReturned(data, original);
    await expectReusedOnly(s, target, original, { admin: s.actor.id, payload: inApp() });
  },
);

it.each([
  { case: '只有一项为真（本该 30419）', payload: inApp({ phone_sms_ok: false }), phone: true },
  { case: '站内信路径而用户未绑手机号（本该 20001）', payload: inApp(), phone: false },
  { case: '企业微信路径而调用者缺 pii.reveal_phone（本该 10403）', payload: wecom(), phone: true },
])(
  '[AC-B1-27c#26] 有未结束请求时不看本次两项通道情况：$case → 仍返回原条',
  async ({ payload, phone }) => {
    const s = await setup(h);
    const target = await user(s, phone ? {} : { phone: null });
    const by = await registrant(s);
    const original = await copy(s, target, {
      requestedBy: by.id,
      delivery: 'wecom_session',
      status: 'ready',
    });
    const caller = await member(s, [PERMISSION]);
    const data = await ok(await register(s, target.id, payload, { as: caller }));
    expectReturned(data, original);
    await expectReusedOnly(s, target, original, { admin: caller.who.id, payload });
  },
);

it('[AC-B1-27c#27] 重复登记没有幂等键也只有一条：第二次返回第一次新建的那条 reused=true', async () => {
  const s = await setup(h);
  const target = await user(s);
  const first = await ok(await register(s, target.id, inApp()));
  expect(first.reused).toBe(false);
  const second = await ok(
    await register(s, target.id, inApp({ reason: '用户再次催办，重复登记' })),
  );
  expect(second).toMatchObject({ export_id: first.export_id, status: 'pending', reused: true });
  expect(ms(second.due_at)).toBe(ms(first.due_at));
  expect(await copiesOf(s, target)).toHaveLength(1);
  expect(jobs(s)).toHaveLength(1);
  const rows = await audits(s);
  expect(rows).toHaveLength(2);
  expectRequestAudit(s, rows[1], {
    admin: s.actor.id,
    user: target,
    reason: '用户再次催办，重复登记',
    channels: { app: true, sms: true },
    contains: [first.export_id],
  });
});

type LostCase = {
  case: string;
  status: CopyStatus;
  registrantStatus: 'active' | 'disabled';
  permissions: readonly string[];
  payload: Body;
  delivery: Delivery;
};

const LOST: LostCase[] = [
  {
    case: '登记人后台账号已停用（ready）',
    status: 'ready',
    registrantStatus: 'disabled',
    permissions: [PERMISSION, PII],
    payload: inApp(),
    delivery: 'in_app_sms',
  },
  {
    case: '登记人不再持 pii.reveal_phone（pending）',
    status: 'pending',
    registrantStatus: 'active',
    permissions: [PERMISSION],
    payload: inApp(),
    delivery: 'in_app_sms',
  },
  {
    case: '登记人不再持 user.data_export（running）',
    status: 'running',
    registrantStatus: 'active',
    permissions: [PII],
    payload: wecom(),
    delivery: 'wecom_session',
  },
  {
    case: '登记人两项都没有了（ready）',
    status: 'ready',
    registrantStatus: 'active',
    permissions: [],
    payload: wecom(),
    delivery: 'wecom_session',
  },
];

it.each(LOST)(
  '[AC-B1-27c#28] 企业微信路径未交付且$case → 原条置 failed，另建新条（retry_of 原条、due_at 沿用、reused=false）并入队',
  async ({ status, registrantStatus, permissions, payload, delivery }) => {
    const s = await setup(h);
    const target = await user(s);
    const by = await registrant(s, { status: registrantStatus, permissions });
    const due = new Date(Date.parse('2026-11-17T16:00:00.000Z'));
    const original = await copy(s, target, {
      requestedBy: by.id,
      delivery: 'wecom_session',
      status,
      dueAt: due,
    });
    const data = await ok(await register(s, target.id, payload));
    expect(data).toMatchObject({
      user_id: target.id,
      delivery,
      status: 'pending',
      requested_by: s.actor.id,
      retry_of: original.id,
      reused: false,
    });
    expect(data.export_id).not.toBe(original.id);
    expect(ms(data.due_at), '截止时刻沿用原条，不重开').toBe(due.getTime());

    const old = await copyRow(s, original.id);
    expect(old.status).toBe('failed');
    expect(old.failure_reason).not.toBeNull();
    const fresh = await copyRow(s, data.export_id);
    expect(fresh).toMatchObject({ status: 'pending', retry_of: original.id, delivery });
    expect(fresh.due_at.getTime()).toBe(due.getTime());
    expect(jobs(s)).toEqual([
      expect.objectContaining({
        queue: QUEUE,
        name: GENERATE,
        payload: { appId: s.appId, copyId: data.export_id },
        inTransaction: true,
      }),
    ]);
    const rows = await audits(s);
    expect(rows).toHaveLength(1);
    expectRequestAudit(s, rows[0], {
      admin: s.actor.id,
      user: target,
      reason: String(payload['reason']),
      channels: channelsOf(payload),
      contains: [data.export_id],
    });
  },
);

it.each([
  {
    case: '站内信路径的请求，登记人已停用',
    delivery: 'in_app_sms' as const,
    registrant: { status: 'disabled' as const, permissions: [PERMISSION, PII] },
  },
  {
    case: '站内信路径的请求，登记人已没有任何权限点',
    delivery: 'in_app_sms' as const,
    registrant: { permissions: [] as string[] },
  },
  {
    case: '企业微信路径的请求，登记人是超级管理员（不另授权限点也持有全部）',
    delivery: 'wecom_session' as const,
    registrant: { isSuper: true, permissions: [] as string[] },
  },
  {
    case: '企业微信路径的请求，登记人照常持两项权限点',
    delivery: 'wecom_session' as const,
    registrant: { permissions: [PERMISSION, PII] },
  },
])(
  '[AC-B1-27c#29] 不属于例外：$case → 返回原条 reused=true，原条不动',
  async ({ delivery, registrant: who }) => {
    const s = await setup(h);
    const target = await user(s);
    const by = await registrant(s, who);
    const original = await copy(s, target, { requestedBy: by.id, delivery, status: 'ready' });
    const data = await ok(await register(s, target.id, inApp()));
    expectReturned(data, original);
    await expectReusedOnly(s, target, original, { admin: s.actor.id, payload: inApp() });
  },
);

it('[AC-B1-27c#30] 并发登记同一用户：只留一条未结束请求，一次新建、一次返回同一条 reused=true，只入队一次', async () => {
  const s = await setup(h);
  const target = await user(s);
  const other = await superAdmin(s);
  const tokens = [await stepUp(s), await stepUp(s, other.who, other.token)];
  const responses = await Promise.all([
    register(s, target.id, inApp(), { stepUp: tokens[0]! }),
    register(s, target.id, inApp(), { as: other, stepUp: tokens[1]! }),
  ]);
  const results = await Promise.all(responses.map((response) => ok(response)));
  expect(results.map((data) => data.reused).sort()).toEqual([false, true]);
  expect(results[0]!.export_id).toBe(results[1]!.export_id);
  const rows = await copiesOf(s, target);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(results[0]!.export_id);
  expect(jobs(s)).toHaveLength(1);
  expect(await queuedJobs(s)).toBe(1);
  expect(await audits(s)).toHaveLength(2);
});
