// B1-27c · a new registration (contract adminCreateUserDataExport point 3 and the paragraph after
// it; 08 BR-ID-40 细则「截止时刻」; task §9 ③ ④ ⑤): both channel facts true → in_app_sms, both false →
// wecom_session; the new request is pending with reused=false, retry_of null, created_at the
// entry's clock and due_at 24:00 (+08:00) of the 15th working day after the +08:00 registration
// date (working days from the app's calendar.cn_holidays / cn_makeup_workdays); the generation job
// of B1-27h goes out on the transaction that inserts the request; one user_data_copy_request audit
// record names the new request.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DUE_OF_NOW,
  GENERATE,
  PERMISSION,
  PII,
  QUEUE,
  REASON,
  WECOM_REASON,
  audits,
  calendar,
  copiesOf,
  deletion,
  expectRequestAudit,
  inApp,
  jobs,
  member,
  ms,
  ok,
  queuedJobs,
  register,
  setup,
  superAdmin,
  user,
  weekdayDeadline,
  wecom,
  type Member,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** The request just registered, as the response, the row, the job and the audit show it. */
async function expectCreated(
  s: Setup,
  target: User,
  response: Awaited<ReturnType<typeof register>>,
  expected: { delivery: 'in_app_sms' | 'wecom_session'; by: string; reason: string; due: string },
) {
  const now = s.clock.now();
  const data = await ok(response);
  expect(data).toMatchObject({
    user_id: target.id,
    delivery: expected.delivery,
    status: 'pending',
    requested_by: expected.by,
    retry_of: null,
    generated_at: null,
    delivered_at: null,
    expires_at: null,
    failure_reason: null,
    reused: false,
  });
  expect(ms(data.created_at), 'created_at = 注入时钟的登记时刻').toBe(now.getTime());
  expect(ms(data.due_at), 'due_at').toBe(Date.parse(expected.due));

  const rows = await copiesOf(s, target);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: data.export_id,
    app_id: s.appId,
    user_id: target.id,
    requested_by: expected.by,
    delivery: expected.delivery,
    status: 'pending',
    retry_of: null,
    object_key: null,
    generated_at: null,
    delivered_at: null,
    expires_at: null,
    failure_reason: null,
  });
  expect(rows[0]!.due_at.getTime()).toBe(Date.parse(expected.due));
  expect(rows[0]!.created_at.getTime()).toBe(now.getTime());

  expect(jobs(s), '同一事务入队一条 data-copy generate').toEqual([
    {
      queue: QUEUE,
      name: GENERATE,
      payload: { appId: s.appId, copyId: data.export_id },
      inTransaction: true,
      insideStatus: 'pending',
      visibleOutside: false,
    },
  ]);
  expect(await queuedJobs(s)).toBe(1);

  // Each test has an app of its own: this registration's record is the only one.
  const auditRows = await audits(s);
  expect(auditRows).toHaveLength(1);
  expectRequestAudit(s, auditRows[0], {
    admin: expected.by,
    user: target,
    reason: expected.reason,
    channels:
      expected.delivery === 'in_app_sms' ? { app: true, sms: true } : { app: false, sms: false },
    contains: [data.export_id],
  });
  expect(auditRows[0]!.at.getTime()).toBe(now.getTime());
  return data;
}

it('[AC-B1-27c#11] 两项都为真 → in_app_sms：pending、reused=false、due_at 为登记日后第 15 个工作日 24:00，同事务入队并写一条审计', async () => {
  const s = await setup(h);
  const target = await user(s);
  await expectCreated(s, target, await register(s, target.id, inApp()), {
    delivery: 'in_app_sms',
    by: s.actor.id,
    reason: REASON,
    due: DUE_OF_NOW,
  });
});

it.each([
  { case: '同时持 user.data_export 与 pii.reveal_phone 的成员', who: 'member' },
  { case: '超级管理员', who: 'super' },
])('[AC-B1-27c#12] 两项都为假 → wecom_session，$case 可以登记', async ({ who }) => {
  const s = await setup(h);
  const target = await user(s, { phone: null });
  const caller: Member =
    who === 'member' ? await member(s, [PERMISSION, PII]) : await superAdmin(s);
  await expectCreated(s, target, await register(s, target.id, wecom(), { as: caller }), {
    delivery: 'wecom_session',
    by: caller.who.id,
    reason: WECOM_REASON,
    due: DUE_OF_NOW,
  });
});

it('[AC-B1-27c#13] 只持 user.data_export 的成员可以登记 in_app_sms（站内信路径不要 pii.reveal_phone）', async () => {
  const s = await setup(h);
  const target = await user(s);
  const caller = await member(s, [PERMISSION]);
  await expectCreated(s, target, await register(s, target.id, inApp(), { as: caller }), {
    delivery: 'in_app_sms',
    by: caller.who.id,
    reason: REASON,
    due: DUE_OF_NOW,
  });
});

it('[AC-B1-27c#14] 截止时刻按应用的工作日历：11-03、11-04 放假、11-07（周六）调休上班 → 11-24 24:00', async () => {
  const s = await setup(h);
  await calendar(s, 2026, ['2026-11-03', '2026-11-04'], ['2026-11-07']);
  const target = await user(s);
  await expectCreated(s, target, await register(s, target.id, inApp()), {
    delivery: 'in_app_sms',
    by: s.actor.id,
    reason: REASON,
    due: '2026-11-24T16:00:00.000Z',
  });
});

it('[AC-B1-27c#15] 跨年：12-24（周四）登记、2027-01-01 放假 → 读到次年日历，截止 2027-01-15 24:00', async () => {
  const s = await setup(h, { now: '2026-12-24T02:00:00.000Z' });
  await calendar(s, 2026, [], []);
  await calendar(s, 2027, ['2027-01-01'], []);
  const target = await user(s);
  await expectCreated(s, target, await register(s, target.id, inApp()), {
    delivery: 'in_app_sms',
    by: s.actor.id,
    reason: REASON,
    due: '2027-01-15T16:00:00.000Z',
  });
});

it.each([
  {
    case: '周一 23:59（+08:00）登记 → 仍按周一起算',
    now: '2026-11-02T15:58:00.000Z',
    due: DUE_OF_NOW,
  },
  {
    case: '周二 01:29（+08:00，UTC 仍是周一）登记 → 按 +08:00 的周二起算',
    now: '2026-11-02T17:29:00.000Z',
    due: '2026-11-24T16:00:00.000Z',
  },
  {
    case: '周六登记 → 周六不计，下周一为第 1 个工作日',
    now: '2026-11-07T02:00:00.000Z',
    due: '2026-11-27T16:00:00.000Z',
  },
])('[AC-B1-27c#16] 登记日取 +08:00 的日期、当日不计：$case', async ({ now, due }) => {
  const s = await setup(h, { now });
  const target = await user(s);
  const response = await register(s, target.id, inApp());
  // Independent cross-check of the literal (November 2026 has no holiday).
  expect(weekdayDeadline(s.clock.now()).toISOString()).toBe(due);
  await expectCreated(s, target, response, {
    delivery: 'in_app_sms',
    by: s.actor.id,
    reason: REASON,
    due,
  });
});

it('[AC-B1-27c#17] 注销冷静期（cooling）照常受理', async () => {
  const s = await setup(h);
  const target = await user(s);
  await deletion(s, target, 'cooling');
  await expectCreated(s, target, await register(s, target.id, inApp()), {
    delivery: 'in_app_sms',
    by: s.actor.id,
    reason: REASON,
    due: DUE_OF_NOW,
  });
});

it('[AC-B1-27c#18] 入队失败时整体回滚：不留请求、不留队列记录；随后重新登记照常新建', async () => {
  const s = await setup(h);
  const target = await user(s);
  s.control.failNext = true;
  const failed = await register(s, target.id, inApp());
  expect(failed.statusCode, JSON.stringify(failed.json())).toBeGreaterThanOrEqual(500);
  expect(await copiesOf(s, target)).toEqual([]);
  expect(await queuedJobs(s)).toBe(0);
  const data = await ok(await register(s, target.id, inApp()));
  expect(data).toMatchObject({ user_id: target.id, status: 'pending', reused: false });
  expect(await copiesOf(s, target)).toHaveLength(1);
  expect(await queuedJobs(s)).toBe(1);
});
