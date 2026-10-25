// B1-27c · registrations not accepted after the permission, step-up and body checks (contract
// adminCreateUserDataExport points 1 and 3; 08 BR-ID-40 细则「副本请求与注销状态」「企业微信会话交付的下载」,
// the paragraph on only one channel working; D10-246, D10-248, D10-250; task §9 ① ③ ⑤): the
// account's deletion in processing or done (30419 account_deleting with stage processing /
// account_deleted), only one channel fact true (30419 delivery_undecided), in_app_sms without a
// bound phone (20001 [phone_sms_ok]), wecom_session by a caller without pii.reveal_phone (10403).
// First hit wins in the contract's order. Each refusal registers nothing, sends no job and writes
// one user_data_copy_request audit record with the reason, the two channel facts and the code.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  PERMISSION,
  audits,
  channelsOf,
  copiesOf,
  copy,
  deletion,
  expectChannelsRecorded,
  expectRequestAudit,
  inApp,
  jobs,
  member,
  queuedJobs,
  register,
  rejected,
  setup,
  user,
  wecom,
  type Body,
  type Channels,
  type Member,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

/** Nothing registered or queued, exactly one audit record carrying `code`. */
async function expectRefusalRecorded(
  s: Setup,
  target: User,
  expected: { admin: string; payload: Body; code: number; copies?: number },
) {
  expect(await copiesOf(s, target)).toHaveLength(expected.copies ?? 0);
  expect(jobs(s)).toEqual([]);
  expect(await queuedJobs(s)).toBe(0);
  const rows = await audits(s);
  expect(rows, '被拒的登记也写一条审计').toHaveLength(1);
  expectRequestAudit(s, rows[0], {
    admin: expected.admin,
    user: target,
    reason: String(expected.payload['reason']),
    channels: channelsOf(expected.payload),
    contains: [String(expected.code)],
  });
}

type StateCase = {
  case: string;
  arrange(s: Setup): Promise<User>;
  data: Record<string, string>;
};

const ACCOUNT_STATES: StateCase[] = [
  {
    case: '注销处理中（users.status=deleting，申请 processing）',
    arrange: async (s) => {
      const target = await user(s, { status: 'deleting' });
      await deletion(s, target, 'processing');
      return target;
    },
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '注销处理中（只有 users.status=deleting）',
    arrange: (s) => user(s, { status: 'deleting' }),
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '已注销（users.status=deleted，申请 done）',
    arrange: async (s) => {
      const target = await user(s, { status: 'deleted', phone: null });
      await deletion(s, target, 'done');
      return target;
    },
    data: { reason: 'account_deleted' },
  },
  {
    case: '已注销（只有 users.status=deleted）',
    arrange: (s) => user(s, { status: 'deleted', phone: null }),
    data: { reason: 'account_deleted' },
  },
];

it.each(ACCOUNT_STATES)(
  '[AC-B1-27c#19] $case → 30419 $data，不建请求、不入队，记一条审计',
  async ({ arrange, data }) => {
    const s = await setup(h);
    const target = await arrange(s);
    await rejected(await register(s, target.id, inApp()), 30419, data);
    await expectRefusalRecorded(s, target, { admin: s.actor.id, payload: inApp(), code: 30419 });
  },
);

it.each([
  {
    case: '注销处理中 + 已有未结束请求 → 注销在先，不返回原条',
    status: 'deleting' as const,
    payload: inApp(),
    open: true,
    pii: true,
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '已注销 + 只有一项为真 → 注销在先',
    status: 'deleted' as const,
    payload: inApp({ phone_sms_ok: false }),
    open: false,
    pii: true,
    data: { reason: 'account_deleted' },
  },
  {
    case: '注销处理中 + 站内信路径未绑手机 → 注销在先',
    status: 'deleting' as const,
    payload: inApp(),
    open: false,
    pii: true,
    phone: null,
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '注销处理中 + 企业微信路径而登记人缺 pii.reveal_phone → 注销在先',
    status: 'deleting' as const,
    payload: wecom(),
    open: false,
    pii: false,
    data: { reason: 'account_deleting', stage: 'processing' },
  },
])(
  '[AC-B1-27c#20] 账号状态最先判定：$case',
  async ({ status, payload, open, pii, phone, data }) => {
    const s = await setup(h);
    const target = await user(s, { status, ...(phone === null ? { phone: null } : {}) });
    if (open) await copy(s, target, { requestedBy: s.actor.id, status: 'pending' });
    const caller: Member | undefined = pii ? undefined : await member(s, [PERMISSION]);
    await rejected(
      await register(s, target.id, payload, caller === undefined ? {} : { as: caller }),
      30419,
      data,
    );
    await expectRefusalRecorded(s, target, {
      admin: caller?.who.id ?? s.actor.id,
      payload,
      code: 30419,
      copies: open ? 1 : 0,
    });
  },
);

it.each([
  { case: '能登录 App、手机号收不到短信', app: true, sms: false },
  { case: '登不上 App、手机号能收短信', app: false, sms: true },
])(
  '[AC-B1-27c#21] 只有一项为真（$case）→ 30419 delivery_undecided，待法务确认不受理，记一条审计',
  async ({ app, sms }) => {
    const s = await setup(h);
    const target = await user(s);
    const payload = inApp({ app_login_ok: app, phone_sms_ok: sms });
    await rejected(await register(s, target.id, payload), 30419, { reason: 'delivery_undecided' });
    await expectRefusalRecorded(s, target, { admin: s.actor.id, payload, code: 30419 });
  },
);

it('[AC-B1-27c#21] 只有一项为真的两种组合：两条审计各自还原出 App 一项与短信一项的真假，彼此可区分', async () => {
  const s = await setup(h);
  const combos: Channels[] = [
    { app: true, sms: false },
    { app: false, sms: true },
  ];
  for (const channels of combos) {
    const target = await user(s);
    const payload = inApp({ app_login_ok: channels.app, phone_sms_ok: channels.sms });
    await rejected(await register(s, target.id, payload), 30419, { reason: 'delivery_undecided' });
    expect(await copiesOf(s, target)).toHaveLength(0);
  }
  expect(jobs(s)).toEqual([]);
  const rows = await audits(s);
  expect(rows, '每次被拒的登记各写一条审计').toHaveLength(2);
  expectChannelsRecorded(combos.map((channels, index) => ({ row: rows[index], channels })));
});

it('[AC-B1-27c#22] 两项都为真而用户未绑手机号 → 20001 fields=[phone_sms_ok]，不建请求，记一条审计', async () => {
  const s = await setup(h);
  const target = await user(s, { phone: null });
  await rejected(await register(s, target.id, inApp()), 20001, { fields: ['phone_sms_ok'] });
  await expectRefusalRecorded(s, target, { admin: s.actor.id, payload: inApp(), code: 20001 });
});

it('[AC-B1-27c#23] 两项都为假而登记人没有 pii.reveal_phone → 10403 admin_permission_denied（免得登记了没人能下载），记一条审计', async () => {
  const s = await setup(h);
  const target = await user(s);
  const caller = await member(s, [PERMISSION]);
  await rejected(await register(s, target.id, wecom(), { as: caller }), 10403, {
    reason: 'admin_permission_denied',
  });
  await expectRefusalRecorded(s, target, { admin: caller.who.id, payload: wecom(), code: 10403 });
});

it.each([
  {
    case: '只有一项为真、登记人缺 pii.reveal_phone → 仍是 delivery_undecided',
    payload: inApp({ app_login_ok: false, phone_sms_ok: true }),
    phone: undefined,
  },
  {
    case: '只有一项为真、用户未绑手机号 → 仍是 delivery_undecided',
    payload: inApp({ app_login_ok: true, phone_sms_ok: false }),
    phone: null,
  },
])('[AC-B1-27c#24] 交付方式按两项通道情况判定：$case', async ({ payload, phone }) => {
  const s = await setup(h);
  const target = await user(s, phone === null ? { phone: null } : {});
  const caller = await member(s, [PERMISSION]);
  await rejected(await register(s, target.id, payload, { as: caller }), 30419, {
    reason: 'delivery_undecided',
  });
  await expectRefusalRecorded(s, target, { admin: caller.who.id, payload, code: 30419 });
});
