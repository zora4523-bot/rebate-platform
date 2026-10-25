// B1-27a · the five not-accepted cases (08 BR-ID-25 细则「实名更正」不受理; D10-246, D10-248, D10-250;
// contract adminCorrectUserRealname): judged before every other check, no vendor call, first hit
// wins, each 30419 with data.reason (and data.stage for a deletion in progress), nothing changed,
// one audit record each. The "pending re-verification" flag (reverify_pending) is not covered: its
// table and task do not exist yet (task §9 ①, TODO blocked).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CLOSED,
  NEW,
  OLD,
  OPEN,
  REASON,
  added,
  audits,
  blacklisted,
  body,
  correct,
  deletion,
  failedRealname,
  maskIdNo,
  ok,
  plaintexts,
  priorWritten,
  rejected,
  rowText,
  setup,
  snapshot,
  user,
  verified,
  withdrawal,
  wrongCheckDigit,
  type Setup,
  type User,
} from './kit.ts';

const h = useHarness();

type Case = {
  case: string;
  arrange(s: Setup): Promise<User>;
  data: Record<string, string>;
};

const CASES: Case[] = [
  {
    case: '从未实名（没有实名记录）',
    arrange: (s) => user(h, s.appId),
    data: { reason: 'realname_not_verified' },
  },
  {
    case: '实名未通过（failed）',
    arrange: async (s) => {
      const target = await user(h, s.appId);
      await failedRealname(h, target);
      return target;
    },
    data: { reason: 'realname_not_verified' },
  },
  {
    case: '注销冷静期',
    arrange: async (s) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await deletion(h, target, 'cooling');
      return target;
    },
    data: { reason: 'account_deleting', stage: 'cooling' },
  },
  {
    case: '注销处理中（申请 processing）',
    arrange: async (s) => {
      const target = await user(h, s.appId, 'deleting');
      await verified(h, target);
      await deletion(h, target, 'processing');
      return target;
    },
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '注销处理中（users.status=deleting）',
    arrange: async (s) => {
      const target = await user(h, s.appId, 'deleting');
      await verified(h, target);
      return target;
    },
    data: { reason: 'account_deleting', stage: 'processing' },
  },
  {
    case: '已注销',
    arrange: async (s) => {
      const target = await user(h, s.appId, 'deleted');
      await verified(h, target);
      await deletion(h, target, 'done');
      return target;
    },
    data: { reason: 'account_deleted' },
  },
  ...OPEN.map((status): Case => ({
    case: `有 ${status} 提现单`,
    arrange: async (s) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await withdrawal(h.db, s.clock, target, status);
      return target;
    },
    data: { reason: 'withdrawal_in_progress' },
  })),
  {
    case: '原实名身份证号在黑名单',
    arrange: async (s) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await blacklisted(h, s.appId, OLD.idNo);
      return target;
    },
    data: { reason: 'identity_blacklisted' },
  },
];

it.each(CASES)(
  '[AC-B1-27a#9] $case → 30419 $data，不调供应商、什么都不改，记一条审计',
  async ({ arrange, data }) => {
    const s = await setup(h);
    const target = await arrange(s);
    const before = { data: await snapshot(h, s.appId), audits: await audits(h, s.appId) };
    const response = await correct(s, target.id, body());
    await rejected(response, 30419, data);
    expect(s.vendor).not.toHaveBeenCalled();
    expect(await snapshot(h, s.appId)).toEqual(before.data);
    expect(priorWritten(s)).toEqual([]);
    const rows = added(before.audits, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    const text = rowText(rows[0]!);
    expect(rows[0]).toMatchObject({ app_id: s.appId, admin_id: s.actor.id });
    expect(text).toContain(REASON);
    expect(text).toContain('30419');
    for (const secret of plaintexts(OLD, NEW)) expect(text).not.toContain(secret);
  },
);

it.each([
  {
    case: '未实名 + 冷静期 → 未实名在先',
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId);
      await deletion(h, target, 'cooling');
      return target;
    },
    data: { reason: 'realname_not_verified' },
  },
  {
    case: '冷静期 + 在途提现 → 注销在先',
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await deletion(h, target, 'cooling');
      await withdrawal(h.db, s.clock, target, 'PENDING_REVIEW');
      return target;
    },
    data: { reason: 'account_deleting', stage: 'cooling' },
  },
  {
    case: '已注销 + 原号黑名单 → 注销在先',
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId, 'deleted');
      await verified(h, target);
      await deletion(h, target, 'done');
      await blacklisted(h, s.appId, OLD.idNo);
      return target;
    },
    data: { reason: 'account_deleted' },
  },
  {
    case: '在途提现 + 原号黑名单 → 提现在先',
    arrange: async (s: Setup) => {
      const target = await user(h, s.appId);
      await verified(h, target);
      await withdrawal(h.db, s.clock, target, 'APPROVED');
      await blacklisted(h, s.appId, OLD.idNo);
      return target;
    },
    data: { reason: 'withdrawal_in_progress' },
  },
])('[AC-B1-27a#10] 命中多项时取第一项：$case', async ({ arrange, data }) => {
  const s = await setup(h);
  const target = await arrange(s);
  await rejected(await correct(s, target.id, body()), 30419, data);
  expect(s.vendor).not.toHaveBeenCalled();
});

it.each([
  {
    case: '未实名用户 + 新号校验位错',
    payload: body(NEW, { id_no: wrongCheckDigit(NEW.idNo) }),
    reason: 'realname_not_verified',
    blacklist: false,
  },
  {
    case: '原号黑名单 + 新号也在黑名单',
    payload: body(NEW),
    reason: 'identity_blacklisted',
    blacklist: true,
  },
])(
  '[AC-B1-27a#11] 不受理在 20001 格式与 44001 之前判定：$case → 30419',
  async ({ payload, reason, blacklist }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    if (blacklist) {
      await verified(h, target);
      await blacklisted(h, s.appId, OLD.idNo);
      await blacklisted(h, s.appId, NEW.idNo);
    }
    await rejected(await correct(s, target.id, payload), 30419, { reason });
    expect(s.vendor).not.toHaveBeenCalled();
  },
);

it('[AC-B1-27a#12] 只有终态提现单（REJECTED / PAID_API / PAID_MANUAL / FAILED）时照常受理', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  for (const status of CLOSED) await withdrawal(h.db, s.clock, target, status);
  const data = await ok(await correct(s, target.id, body()));
  expect(data).toMatchObject({ user_id: target.id, masked_id_no: maskIdNo(NEW.idNo) });
  expect(s.vendor).toHaveBeenCalledTimes(1);
});
