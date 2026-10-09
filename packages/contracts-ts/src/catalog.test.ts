import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { enums, errorCodeRanges, errorCodes, ledger_type, platform, scene } from './index.ts';

const codes = Object.keys(errorCodes).map(Number);

it('error codes are 5-digit, unique and outside the reserved ranges', () => {
  expect(codes.length).toBeGreaterThan(0);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) {
    expect(code).toBeGreaterThanOrEqual(10000);
    expect(code).toBeLessThanOrEqual(59999);
    for (const r of errorCodeRanges) expect(code < r.from || code > r.to).toBe(true);
  }
  expect(errorCodeRanges).toEqual([{ from: 90001, to: 90500, meaning: 'JSBridge 专用码段' }]);
});

it('HTTP status follows the code segment (04 §7 码段)', () => {
  const allowed = (code: number): number[] => {
    if (code >= 44000 && code < 45000) return [403];
    if (code >= 42900 && code < 43000) return [429];
    if (code >= 40900 && code < 41000) return [409];
    if (code < 20000) return [401, 403];
    if (code < 30000) return [400, 409];
    if (code < 40000) return [404, 409, 422];
    return [500, 503, 504];
  };
  for (const code of codes) {
    const entry = errorCodes[code as keyof typeof errorCodes];
    expect(allowed(code)).toContain(entry.http);
  }
  // The only statuses 04 §7 fixes explicitly.
  expect(errorCodes[30803].http).toBe(409);
  expect(errorCodes[30804].http).toBe(409);
});

it('only 20001 has extra statuses: request-body errors keep 413 / 415 (CT-01d)', () => {
  const withExtra = codes.filter(
    (c) => errorCodes[c as keyof typeof errorCodes].http_also.length > 0,
  );
  expect(withExtra).toEqual([20001]);
  expect(errorCodes[20001].http).toBe(400);
  expect(errorCodes[20001].http_also).toEqual([413, 415]);
});

it('deprecated codes stay allocated and are marked (废弃码不回收)', () => {
  const deprecated = codes.filter((c) => errorCodes[c as keyof typeof errorCodes].deprecated);
  expect(deprecated).toEqual([30142, 30152]);
  expect(errorCodes[30310 as keyof typeof errorCodes]).toBeUndefined();
});

it('data shapes of the link and search path match 04 §7', () => {
  expect(errorCodes[30101].data).toEqual({
    auth_url: null,
    state: null,
    auth_methods: ['web_code', 'sdk_token'],
    reason: ['auth_unavailable'],
  });
  expect(errorCodes[30102].data).toEqual({
    auth_url: null,
    state: null,
    auth_methods: ['web_code', 'sdk_token'],
    reason: ['auth_unavailable', 'sharer_auth_invalid'],
  });
  expect(errorCodes[30104].data).toEqual({ reason: ['credential_invalid', 'method_not_allowed'] });
  expect(errorCodes[30111].data).toEqual({ auth_jump: null, reason: ['sharer_auth_invalid'] });
  expect(errorCodes[30101].data.reason).not.toContain('sharer_auth_invalid');
  expect(errorCodes[50301].data).toEqual({
    platform: null,
    reason: ['maintenance', 'not_launched'],
  });
  expect(errorCodes[50304].data).toEqual({ platform: null, reason: ['search_disabled'] });
  expect(errorCodes[50304].retry_kind_by_reason).toEqual({ search_disabled: 'never' });
  expect(errorCodes[42901].headers).toEqual(['Retry-After']);
});

it('retry policy splits by data.reason where 08 §13.11 does', () => {
  expect(errorCodes[50301].retry_kind_by_reason).toEqual({
    maintenance: 'later',
    not_launched: 'never',
  });
  expect(errorCodes[30101].retry_kind_by_reason).toEqual({ auth_unavailable: 'later' });
  expect(errorCodes[30102].retry_kind_by_reason).toEqual({
    auth_unavailable: 'later',
    sharer_auth_invalid: 'never',
  });
  expect(errorCodes[30111].retry_kind_by_reason).toEqual({ sharer_auth_invalid: 'never' });
  expect(errorCodes[30102].sources).toContain('BR-ATTR-05');
  expect(errorCodes[30111].sources).toContain('BR-ATTR-05');
  expect(errorCodes[10001].retry_kind_by_reason).toEqual({});
});

it('every enum is non-empty with unique values', () => {
  for (const [name, values] of Object.entries(enums)) {
    expect(values.length, name).toBeGreaterThan(0);
    expect(new Set(values).size, name).toBe(values.length);
  }
});

it('enums carry the 04 §2 value sets', () => {
  expect(platform).toEqual([
    'taobao',
    'jd',
    'pdd',
    'meituan',
    'vip',
    'douyin',
    'eleme',
    'kuaishou',
    'suning',
  ]);
  expect(ledger_type).toHaveLength(13);
  expect(scene).toContain('watch_alert');
  expect(enums.notify_category).toEqual(['service', 'subscription', 'marketing']);
  expect(enums.admin_permission).toContain('user.list');
  expect(enums.admin_permission).toContain('payout.execute');
  expect(enums.admin_permission).toContain('content.fund_terms');
});

it('identity codes of 08 §13.11 (功能对照补缺 1–3 批) carry their data shapes', () => {
  // 10405 is not a credential failure: 403, so that a 401 interceptor does not clear the session
  // (orchestrator decision j-05; 04 and 08 fix no HTTP status for it).
  expect(errorCodes[10405].http).toBe(403);
  expect(errorCodes[10405].data).toEqual({ min_supported_version: null, reason: ['no_account'] });
  // 08 §13.11 10403 row: h5_read_only (BR-ID-32) plus the admin reasons of BR-ID-34 (2026-10-06).
  expect(errorCodes[10403].data).toEqual({
    reason: ['h5_read_only', 'admin_ip_not_allowed', 'admin_permission_denied'],
  });
  expect(errorCodes[20004].data).toEqual({ reason: ['identity_mismatch'] });
  expect(errorCodes[50305].data).toEqual({ provider: ['wechat', 'apple', 'huawei'] });
  expect(errorCodes[20001].data.reason).toEqual([
    'watch_target_invalid',
    'nickname_sensitive',
    'invalid_device_hash',
    'phone_invalid',
    // CT-17g: admin-only platform mark upload rejections (BR-TEXT-24 细则).
    'icon_format_invalid',
    'icon_too_large',
    'icon_svg_unconvertible',
  ]);
  expect(errorCodes[30701].sources).toEqual(['规划/04 §7', 'BR-ID-10']);
});

it('order enums carry the 资金规则对齐 additions (04 §2.3)', () => {
  expect(enums.order_hold_reason).toEqual(['RISK', 'CS', 'UNMAPPED_STATUS']);
  expect(enums.order_rights_type).toEqual([
    'RIGHTS',
    'PUNISH',
    'INVALID_AFTER_SETTLE',
    'REFUND_AFTER_SETTLE',
  ]);
});

it('fund enums carry the 资金规则对齐 additions (04 §2.4, §2.5)', () => {
  expect(enums.recon_diff_type).toContain('estimate_changed_after_credit');
  expect(enums.settle_batch_item_type).toEqual(['order', 'beneficiary']);
  expect(enums.settle_adjustment_status).toEqual([
    'pending',
    'approved',
    'rejected',
    'voided_stale_seq',
    'voided_by_clawback',
  ]);
  expect(enums.beneficiary_credit_kind).toEqual(['first_credit', 'reassign_credit', 'deferred']);
  expect(enums.beneficiary_credit_status).toEqual(['open', 'done', 'forfeited', 'voided']);
  expect(enums.payout_batch_item_result).toEqual(['paying', 'skipped', 'blocked', 'moved_out']);
});

// CT-01c §9 acceptance points; the task has no separate business AC identifiers.
it('[AC-CT-01c#1] removes the cancelled ticket enums (04 §2.5)', () => {
  expect.soft(enums).not.toHaveProperty('ticket_type');
  expect.soft(enums).not.toHaveProperty('ticket_status');
});

it('[AC-CT-01c#2] synchronizes the admin permissions (04 §11.2; 54 since CT-17f)', () => {
  expect.soft(enums.admin_permission).toHaveLength(54);
  expect.soft(enums.admin_permission).not.toContain('ticket.handle');
  expect.soft(enums.admin_permission).not.toContain('ticket.data_export');
  for (const permission of [
    'content.app_version',
    'union.pid',
    'fund.cash_entry',
    'user.realname_fix',
    'user.phone_change',
    'user.data_export',
    'agent.report',
  ]) {
    expect.soft(enums.admin_permission, permission).toContain(permission);
  }
});

it('[AC-CT-01c#3] limits 20902 resources to active contracts (04 §7)', () => {
  expect(errorCodes[20902].data.resource).toEqual([
    'order',
    'order_attribution',
    'withdrawal',
    'settle_batch',
    // CT-17g: admin platform mark publish / restore CAS (04 §6.6, BR-TEXT-24).
    'platform_icon',
  ]);
});

it('[AC-CT-01c#4] includes closed in reconciliation statuses (04 §2.5)', () => {
  expect(enums.recon_diff_status).toEqual([
    'open',
    'processing',
    'adjusted',
    'written_off',
    'closed',
  ]);
});

// Permission notes are comments in the generated TS catalog, so read the YAML source.
// Use the same test-only loader as openapi.test.ts, without adding a runtime dependency.
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const adminCatalog = parseYamlLite(
  readFileSync(new URL('../../../contracts/enums/admin.yaml', import.meta.url), 'utf8'),
) as { enums: { admin_permission: { values: Record<string, string> } } };
const permissionNotes = adminCatalog.enums.admin_permission.values;

it.each([
  'union.pid',
  'fund.cash_entry',
  'user.realname_fix',
  'user.phone_change',
  'user.data_export',
  'withdraw.review',
])('[AC-CT-01c#5] %s requires step-up (04 §11.2)', (permission) => {
  expect(permissionNotes[permission]).toBeTypeOf('string');
  expect(permissionNotes[permission]).toContain('（step-up）');
});

it('[AC-CT-01c#5] agent.report does not require step-up (04 §11.2)', () => {
  expect(permissionNotes['agent.report']).toBeTypeOf('string');
  expect(permissionNotes['agent.report']).not.toContain('step-up');
});

// CT-21a: the payments line permissions of 04 §11.2 (2026-10-04).
it('[CT-21a] adds pay.view, pay.refund, pay.resolve and switch.pay (04 §11.2)', () => {
  for (const permission of ['pay.view', 'pay.refund', 'pay.resolve', 'switch.pay']) {
    expect.soft(enums.admin_permission, permission).toContain(permission);
  }
});

it.each(['pay.resolve', 'switch.pay'])('[CT-21a] %s requires step-up (04 §11.2)', (permission) => {
  expect(permissionNotes[permission]).toBeTypeOf('string');
  expect(permissionNotes[permission]).toContain('（step-up）');
});

it.each(['pay.view', 'pay.refund'])(
  '[CT-21a] %s does not require step-up (04 §11.2)',
  (permission) => {
    expect(permissionNotes[permission]).toBeTypeOf('string');
    expect(permissionNotes[permission]).not.toContain('step-up');
  },
);

it('[CT-21a] switch.pay and switch.payout do not cover each other (04 §11.2)', () => {
  expect(permissionNotes['switch.pay']).toContain('pay.enabled');
  expect(permissionNotes['switch.pay']).not.toContain('payout.');
  expect(permissionNotes['switch.payout']).not.toMatch(/(?:^|、|：)pay\./);
});

// CT-17f: platform mark replacement images (04 §11.2, BR-TEXT-24).
it('[CT-17f] adds content.platform_icon without step-up (04 §11.2, BR-TEXT-24)', () => {
  expect(enums.admin_permission).toContain('content.platform_icon');
  expect(permissionNotes['content.platform_icon']).toBeTypeOf('string');
  expect(permissionNotes['content.platform_icon']).toContain('BR-TEXT-24');
  expect(permissionNotes['content.platform_icon']).not.toContain('step-up');
});

it('[AC-CT-01c#5] content.app_version limits step-up to raising the minimum version (04 §11.2)', () => {
  const note = permissionNotes['content.app_version'];
  expect(note).toBeTypeOf('string');
  expect(note).toContain('（step-up）');
  expect(note).toMatch(/(?:仅|只).*提高最低支持版本|提高最低支持版本.*(?:才|仅)/);
});
