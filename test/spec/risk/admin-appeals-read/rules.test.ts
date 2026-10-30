// B1-03zd: the two pure rules behind the detail and the lookup (CT-24r adminGetAppeal
// revoke_permission, 编排裁定 D10-154; AdminBlockedRequest cause / blocklist_dimension from the
// rule codes blocklist.ts and identity's risk ports write).
import { expect, it } from 'vitest';
import {
  appealRevokePermission,
  blockedRequestCause,
} from '../../../../apps/api/src/modules/risk/application/admin-appeals-read.ts';

it.each([
  [{ target_type: 'account', prev_risk_state: 'banned', cause: null }, 'risk.ban'],
  [{ target_type: 'account', prev_risk_state: 'frozen', cause: null }, 'risk.freeze'],
  [{ target_type: 'blocked_request', prev_risk_state: null, cause: 'blocklist' }, 'risk.blocklist'],
  [{ target_type: 'blocked_request', prev_risk_state: null, cause: 'rule' }, null],
  [{ target_type: 'order', prev_risk_state: null, cause: null }, null],
] as const)('[AC-B1-03zd#3] revoke_permission %j → %s', (input, expected) => {
  expect(appealRevokePermission(input)).toBe(expected);
});

it.each([
  ['BLACKLIST_PHONE', 'phone'],
  ['BLACKLIST_ID_NO', 'id_no'],
  ['BLACKLIST_ALIPAY', 'alipay'],
  ['BLACKLIST_BANK_CARD', 'bank_card'],
  ['BLACKLIST_WECHAT_OPENID', 'wechat_openid'],
  ['BLACKLIST_DEVICE', 'device'],
  ['BLACKLIST_RELATION_ID', 'relation_id'],
] as const)('[AC-B1-03zd#4] 名单规则 %s 的拦截原因为 blocklist / %s', (ruleId, dimension) => {
  expect(blockedRequestCause([ruleId])).toEqual({
    cause: 'blocklist',
    blocklist_dimension: dimension,
  });
});

it.each(['DEVICE_REGISTER_LIMIT', 'SMS_BLOCKED_PREFIX', 'RIGHTS_ABUSE'])(
  '[AC-B1-03zd#5] 非名单规则 %s 的拦截原因为 rule，维度为 null',
  (ruleId) => {
    expect(blockedRequestCause([ruleId])).toEqual({ cause: 'rule', blocklist_dimension: null });
  },
);

it('[AC-B1-03zd#6] 同一次请求命中两个名单维度仍是 blocklist，维度取其中之一', () => {
  const result = blockedRequestCause(['BLACKLIST_PHONE', 'BLACKLIST_DEVICE']);
  expect(result.cause).toBe('blocklist');
  expect(['phone', 'device']).toContain(result.blocklist_dimension);
});
