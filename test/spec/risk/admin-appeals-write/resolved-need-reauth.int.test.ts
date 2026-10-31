// B1-03ze spec-test round 3 (money r1 S1): the appeal.resolved data carries, besides the six fields
// {app_id, appeal_id, user_id, target_type, target_id, status}, the boolean need_reauth (编排定;
// D10-141, BR-TEXT-23, the live consumer notification-appeal-result). need_reauth is true only when
// a revoked ban appeal unbanned the user and their taobao binding became invalid by it (BR-ID-31);
// every other resolution carries false. The data is compared exactly: no field missing, none extra.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  EXTRA,
  appealOf,
  binding,
  resolution,
  resolvedEvents,
  seed,
  setup,
  type AppealRow,
  type Decision,
  type Kind,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const ALL = ['risk.appeal', ...EXTRA];

type BindingPatch = NonNullable<Parameters<typeof binding>[2]>;

const bindingRow = (s: Scenario, id: string) =>
  s.h.db.selectFrom('union_bindings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** Resolves with every point and, for a revocation, a fresh step-up token. */
async function close(s: Scenario, id: string, decision: Decision) {
  const token = decision === 'revoked' ? await s.issue() : null;
  return s.resolve(id, resolution(decision, 0), token);
}

/** The exact data of the appeal's appeal.resolved event. */
const expected = (s: Scenario, row: AppealRow, decision: Decision, needReauth: boolean) => ({
  app_id: s.appId,
  appeal_id: row.id,
  user_id: row.user_id,
  target_type: row.target_type,
  target_id: row.target_id,
  status: decision,
  need_reauth: needReauth,
});

it('[AC-B1-03ze#75] 撤销封禁申诉、淘宝绑定因解封改为 invalid：appeal.resolved 载荷恰为六字段加 need_reauth=true', async () => {
  const s = await setup(h, { grants: ALL });
  const { row, user } = await seed(s, 'banned');
  const taobao = await binding(s, user!.id, { status: 'blocked', blocked_reason: 'ban' });
  await appealOf(await close(s, row.id, 'revoked'));
  expect(await bindingRow(s, taobao.id)).toMatchObject({ status: 'invalid' });
  const events = await resolvedEvents(s);
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toStrictEqual(expected(s, row, 'revoked', true));
});

const ACTIVE: BindingPatch = {};
const BAN_BLOCKED: BindingPatch = { status: 'blocked', blocked_reason: 'ban' };

it.each<[string, Kind, Decision, readonly BindingPatch[]]>([
  ['维持封禁（淘宝绑定仍因封禁冻结）', 'banned', 'upheld', [BAN_BLOCKED]],
  ['撤销封禁、没有任何联盟绑定', 'banned', 'revoked', []],
  [
    '撤销封禁、只有因封禁冻结的拼多多绑定（解封后恢复 active）',
    'banned',
    'revoked',
    [{ platform: 'pdd', status: 'blocked', blocked_reason: 'ban' }],
  ],
  [
    '撤销封禁、淘宝绑定为后台停用（解封不动它）',
    'banned',
    'revoked',
    [{ status: 'blocked', blocked_reason: 'admin_disable' }],
  ],
  ['撤销冻结（淘宝绑定正常）', 'frozen', 'revoked', [ACTIVE]],
  ['维持冻结（淘宝绑定正常）', 'frozen', 'upheld', [ACTIVE]],
  ['维持订单申诉', 'order', 'upheld', [ACTIVE]],
  ['撤销订单申诉', 'order', 'revoked', [ACTIVE]],
  ['维持非名单拦截的提现被拦请求申诉', 'rule', 'upheld', [ACTIVE]],
  ['撤销非名单拦截的提现被拦请求申诉', 'rule', 'revoked', [ACTIVE]],
  ['维持名单拦截的换手机号被拦请求申诉', 'blocklist', 'upheld', [ACTIVE]],
  ['撤销名单拦截的换手机号被拦请求申诉', 'blocklist', 'revoked', [ACTIVE]],
  ['维持注册类被拦请求申诉（无账号）', 'register', 'upheld', []],
  ['撤销注册类被拦请求申诉（无账号）', 'register', 'revoked', []],
])(
  '[AC-B1-03ze#76] %s：appeal.resolved 载荷恰为六字段加 need_reauth=false',
  async (_label, kind, decision, bindings) => {
    const s = await setup(h, { grants: ALL });
    const { row, user } = await seed(s, kind);
    for (const patch of bindings) await binding(s, user!.id, patch);
    await appealOf(await close(s, row.id, decision));
    const events = await resolvedEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toStrictEqual(expected(s, row, decision, false));
  },
);
