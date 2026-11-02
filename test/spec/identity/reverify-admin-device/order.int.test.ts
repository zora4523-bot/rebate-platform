// B1-02zx §9 #2 · "Checks, in this order, first hit wins" (contract adminAddUserReverifiedDevice):
// permission → step-up → body → user_id → device_id → deletion complete → no flag. Each case has
// two neighbours hit at once and pins which answers. Each condition alone is pinned in
// access.int.test.ts and targets.int.test.ts.
import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  account,
  body,
  deleted,
  deviceOf,
  flag,
  member,
  record,
  rejected,
  revoke,
  setup,
  unowned,
  user,
  watch,
} from './kit.ts';

const h = useHarness();

const BLANK = '   ';
const STEP_UP_REQUIRED = { tier: 'totp' };
const DENIED = { reason: 'admin_permission_denied' };
const NOT_PENDING = { reason: 'reverify_not_pending' };
const ACCOUNT_DELETED = { reason: 'account_deleted' };

it('[AC-B1-02zx#18] 权限最先：没有权限点时，不带 step-up、请求体不合格、user_id 未知、设备不对都还是 10403，不记审计', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const stray = await unowned(s);
  const admin = await member(s, []);
  const nothingChanged = await watch(s);
  const as = { as: admin };
  await rejected(await record(s, target.id, body(device), { ...as, stepUp: null }), 10403, DENIED);
  await rejected(await record(s, target.id, body(device, BLANK), as), 10403, DENIED);
  await rejected(await record(s, randomUUID(), body(device), as), 10403, DENIED);
  await rejected(await record(s, target.id, body(stray), as), 10403, DENIED);
  await nothingChanged();
});

it('[AC-B1-02zx#19] step-up 其次：不带令牌时，请求体不合格、user_id 未知、设备不对、无标记都还是 10003，不记审计', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const plain = await user(h, s.appId);
  const plainDevice = await deviceOf(s, plain);
  const stray = await unowned(s);
  const nothingChanged = await watch(s);
  const none = { stepUp: null };
  await rejected(await record(s, target.id, body(device, BLANK), none), 10003, STEP_UP_REQUIRED);
  await rejected(await record(s, randomUUID(), body(device), none), 10003, STEP_UP_REQUIRED);
  await rejected(await record(s, target.id, body(stray), none), 10003, STEP_UP_REQUIRED);
  await rejected(await record(s, plain.id, body(plainDevice), none), 10003, STEP_UP_REQUIRED);
  await nothingChanged();
});

it('[AC-B1-02zx#20] 请求体先于 user_id：reason 去空白后为空或缺 device_id，且 user_id 未知 → 点名请求体字段，不记审计', async () => {
  const s = await setup(h);
  const { device } = await account(s);
  const nothingChanged = await watch(s);
  await rejected(await record(s, randomUUID(), body(device, BLANK)), 20001, { fields: ['reason'] });
  await rejected(await record(s, randomUUID(), { reason: '核' }), 20001, { fields: ['device_id'] });
  await nothingChanged();
});

it('[AC-B1-02zx#21] user_id 先于 device_id：两个都未知 → [user_id]', async () => {
  const s = await setup(h);
  const stray = await unowned(s);
  await rejected(await record(s, randomUUID(), body(stray)), 20001, { fields: ['user_id'] });
});

it('[AC-B1-02zx#22] device_id 先于已注销：已注销账号 + 未知、吊销或别人的设备 → [device_id]，不是 account_deleted', async () => {
  const s = await setup(h);
  const target = await deleted(s);
  const revoked = await deviceOf(s, target);
  await revoke(s, revoked);
  const others = await deviceOf(s, await user(h, s.appId));
  for (const stray of [{ id: randomUUID() }, revoked, others]) {
    await rejected(await record(s, target.id, body(stray)), 20001, { fields: ['device_id'] });
  }
});

it('[AC-B1-02zx#23] 已注销先于无标记：墓碑没有标记也是 account_deleted，不是 reverify_not_pending', async () => {
  const s = await setup(h);
  const tombstone = await deleted(s);
  const device = await deviceOf(s, tombstone);
  await rejected(await record(s, tombstone.id, body(device)), 30419, ACCOUNT_DELETED);

  // The control: the same shape on a live account is the other reason.
  const plain = await user(h, s.appId);
  const own = await deviceOf(s, plain);
  await rejected(await record(s, plain.id, body(own)), 30419, NOT_PENDING);
  await flag(s, tombstone);
  await rejected(await record(s, tombstone.id, body(device)), 30419, ACCOUNT_DELETED);
});

it('[AC-B1-02zx#24] device_id 先于无标记：无标记账号 + 不是它的设备 → [device_id]，不是 reverify_not_pending', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const stray = await unowned(s);
  await rejected(await record(s, target.id, body(stray)), 20001, { fields: ['device_id'] });
});
