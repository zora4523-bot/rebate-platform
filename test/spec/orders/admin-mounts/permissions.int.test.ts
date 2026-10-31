// B1-10m: the permission points and step-up tiers of the eight operations through the real admin
// entry (contracts/openapi.yaml, specs/permissions.yaml): adminApproveClaimItem / Reject and the
// imports order.claim, hold / unhold order.hold without step-up, reassign order.assign with a totp
// token; a channel import also needs risk.blocklist and a totp token, rights and punish do not.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  ANSWER,
  DENIED,
  GRANTS,
  STEP_UP_REQUIRED,
  accepted,
  allowed,
  arrange,
  refused,
  setup,
  type Action,
} from './kit.ts';

const h = useHarness();

it.each(ACTIONS)(
  '[AC-B1-10m#3] %s 没带 admin_token → 10001，什么都不写',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act({ caller: null }), 10001);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

const WRONG_POINTS: readonly (readonly [Action, readonly string[]])[] = [
  ['approve', ['order.view', 'user.lookup', 'order.hold', 'order.assign']],
  ['reject', ['order.view', 'user.lookup', 'order.hold', 'order.assign']],
  ['hold', ['order.view', 'order.claim', 'order.assign']],
  ['unhold', ['order.view', 'order.claim', 'order.assign']],
  ['reassign', ['order.view', 'order.claim', 'order.hold']],
  ['rights', ['order.view', 'order.hold', 'risk.blocklist']],
  ['channel', ['order.view', 'order.hold', 'risk.blocklist']],
  ['channel', ['order.view', 'order.claim']],
  ['list', ['order.view', 'order.hold', 'user.lookup']],
  ['detail', ['order.view', 'order.hold', 'user.lookup']],
];

it.each(WRONG_POINTS)(
  '[AC-B1-10m#4] %s 只有 %j（带有效动态码也一样）→ 10403 admin_permission_denied，什么都不写',
  async (action, grants) => {
    const s = await setup(h, { grants });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act({ stepUp: await s.stepUp(s.admin) }), 10403, DENIED);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

it.each(ACTIONS.filter((action) => action !== 'reassign' && action !== 'channel'))(
  '[AC-B1-10m#5] %s 只持所需权限点、不带动态码 → 放行（无 step-up）',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    await accepted(await act(), ANSWER[action]);
  },
  120_000,
);

it.each(['reassign', 'channel'] as const)(
  '[AC-B1-10m#6] %s 持所需权限点、动态码档 token 有效 → 放行',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    await accepted(await act(await allowed(s, action)), ANSWER[action]);
  },
  120_000,
);

it.each([
  ['reassign', '没带 X-Step-Up-Token', undefined],
  ['reassign', 'X-Step-Up-Token 无效', 'not-an-issued-step-up-token'],
  ['channel', '没带 X-Step-Up-Token', undefined],
  ['channel', 'X-Step-Up-Token 无效', 'not-an-issued-step-up-token'],
] as const)(
  '[AC-B1-10m#7] %s %s → 10003 tier=totp，什么都不写',
  async (action, _label, token) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act(token === undefined ? {} : { stepUp: token }), 10003, STEP_UP_REQUIRED);
    expect(await s.state()).toEqual(before);
  },
  120_000,
);

it('[AC-B1-10m#8] reassign 的动态码 token 成功后已消耗：再用同一个 → 10003', async () => {
  const s = await setup(h, { grants: GRANTS.reassign });
  const act = await arrange(s, 'reassign');
  const token = await s.stepUp(s.admin);
  await accepted(await act({ stepUp: token }), ANSWER.reassign);
  await refused(await act({ stepUp: token }), 10003, STEP_UP_REQUIRED);
}, 120_000);

it('[AC-B1-10m#9] 别的账号的动态码 token 不算数：reassign → 10003，什么都不写', async () => {
  const s = await setup(h, { grants: GRANTS.reassign });
  const act = await arrange(s, 'reassign');
  const other = await s.caller(GRANTS.reassign);
  const before = await s.state();
  await refused(await act({ stepUp: await s.stepUp(other) }), 10003, STEP_UP_REQUIRED);
  expect(await s.state()).toEqual(before);
}, 120_000);

it.each(ACTIONS)(
  '[AC-B1-10m#10] 超管不勾权限点也可以 %s（动态码档照旧要 token）',
  async (action) => {
    const s = await setup(h, { isSuper: true });
    const act = await arrange(s, action);
    await accepted(await act(await allowed(s, action)), ANSWER[action]);
  },
  120_000,
);

it('[AC-B1-10m#11] 权限撤销后下一次请求立即拒绝', async () => {
  const s = await setup(h, { grants: GRANTS.hold });
  const first = await arrange(s, 'hold');
  await accepted(await first(), ANSWER.hold);
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.admin.id)
    .execute();
  const second = await arrange(s, 'hold');
  await refused(await second(), 10403, DENIED);
}, 120_000);
