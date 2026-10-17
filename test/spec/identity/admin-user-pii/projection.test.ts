// BR-ID-33 / CT-02j: only the phone is available this batch. Real name / ID number are
// deliberately absent from AdminUser*; their masking belongs to the later real-name feature.
import { randomInt } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  projectAdminUser,
  type AdminUserViewSource,
} from '../../../../apps/api/src/modules/identity/application/admin-user-view.ts';
import { checkSchema } from './schema.ts';

const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const AT = '2026-10-01T02:03:04.000Z';
const RISK = {
  state: 'normal',
  reason_category: null,
  reason: null,
  frozen_until: null,
  changed_by: null,
  changed_at: null,
  row_version: null,
} as const;

function source(phone: string | null) {
  return {
    user: {
      id: ID,
      nickname: '测试昵称',
      level: 'L1',
      invite_code: 'DEMO7A',
      parent_id: null,
      register_method: 'phone',
      registered_channel: 'test',
      created_at: new Date(AT),
      // Adversarial extra columns: a spread of the source row must not leak them.
      phone_cipher: Buffer.from('synthetic-cipher'),
      phone_hmac: 'synthetic-blind-index',
      attr_code: 'private-attribution-code',
      real_name: '测试姓名',
      id_no: 'synthetic-identity-number',
      app_id: 'private-app',
    },
    phone,
    risk: { ...RISK, private_rule: 'internal-rule' },
    unionBindings: [
      {
        platform: 'taobao' as const,
        status: 'active' as const,
        blocked_reason: null,
        bound_at: AT,
        released_at: null,
        cooldown_until: null,
        reason: null,
        row_version: 0,
        relation_id: 'private-relation',
        special_id: 'private-special',
        pdd_custom: 'private-custom',
        union_account_id: 'private-union-account',
      },
    ],
  };
}

// Values are generated only in the isolated test runner, never saved as plaintext fixtures.
function syntheticPhone(prefix: string): string {
  return `${prefix}${String(randomInt(100_000_000)).padStart(8, '0')}`;
}

it.each(['138', '159', '180'])(
  '[AC-F1-07a#1] 列表投影 %s 手机只留首三末四，并严格限制为非敏感字段',
  async (prefix) => {
    const phone = syntheticPhone(prefix);
    const input = source(phone);
    const before = JSON.stringify(input);
    const actual = projectAdminUser(input, 'list');
    expect(actual).toEqual({
      user_id: ID,
      nickname: '测试昵称',
      phone_masked: `${prefix}****${phone.slice(-4)}`,
      level: 'L1',
      risk_state: 'normal',
      created_at: AT,
    });
    expect(JSON.stringify(actual)).not.toContain(phone);
    expect(JSON.stringify(input)).toBe(before);
    await checkSchema('AdminUserListItem', actual);
  },
);

it('[AC-F1-07a#2] 详情逐层白名单，手机脱敏，不透传 relation_id、密文或实名字段', async () => {
  const phone = syntheticPhone('138');
  const actual = projectAdminUser(source(phone), 'detail');
  expect(actual).toEqual({
    user_id: ID,
    nickname: '测试昵称',
    phone_masked: `138****${phone.slice(-4)}`,
    invite_code: 'DEMO7A',
    inviter_user_id: null,
    level: 'L1',
    register_method: 'phone',
    registered_channel: 'test',
    created_at: AT,
    risk: RISK,
    union_bindings: [
      {
        platform: 'taobao',
        status: 'active',
        blocked_reason: null,
        bound_at: AT,
        released_at: null,
        cooldown_until: null,
        reason: null,
        row_version: 0,
      },
    ],
  });
  expect(JSON.stringify(actual)).not.toContain(phone);
  await checkSchema('AdminUserDetail', actual);
});

it('[AC-F1-07a#3] 未绑手机在列表和详情均为 null，不伪造脱敏串', async () => {
  const input = source(null);
  const listed = projectAdminUser(input, 'list');
  const detail = projectAdminUser(input, 'detail');
  expect(listed.phone_masked).toBeNull();
  expect(detail.phone_masked).toBeNull();
  await checkSchema('AdminUserListItem', listed);
  await checkSchema('AdminUserDetail', detail);
});

it('[AC-F1-07a#4] 投影保留契约内的业务值，不把不同用户统一成占位数据', async () => {
  const input = source(null);
  input.user.level = 'L3';
  input.user.nickname = '另一用户';
  const parent = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
  const changed: AdminUserViewSource = {
    ...input,
    user: { ...input.user, parent_id: parent, registered_channel: null },
    risk: { ...RISK, state: 'banned', row_version: 0 },
    unionBindings: [],
  };
  const listed = projectAdminUser(changed, 'list');
  const detail = projectAdminUser(changed, 'detail');
  expect(listed).toMatchObject({ level: 'L3', nickname: '另一用户', risk_state: 'banned' });
  expect(detail).toMatchObject({
    level: 'L3',
    inviter_user_id: parent,
    registered_channel: null,
    risk: { state: 'banned', row_version: 0 },
    union_bindings: [],
  });
  await checkSchema('AdminUserDetail', detail);
});
