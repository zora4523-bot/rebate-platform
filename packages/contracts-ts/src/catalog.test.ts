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

it('deprecated codes stay allocated and are marked (废弃码不回收)', () => {
  const deprecated = codes.filter((c) => errorCodes[c as keyof typeof errorCodes].deprecated);
  expect(deprecated).toEqual([30142, 30152]);
  expect(errorCodes[30310 as keyof typeof errorCodes]).toBeUndefined();
});

it('data shapes of the link and search path match 04 §7', () => {
  expect(errorCodes[30101].data).toEqual({
    auth_url: null,
    state: null,
    reason: ['auth_unavailable'],
  });
  expect(errorCodes[50301].data).toEqual({
    platform: null,
    reason: ['maintenance', 'not_launched'],
  });
  expect(errorCodes[50304].data).toEqual({ platform: null });
  expect(errorCodes[20902].data.resource).toEqual([
    'order',
    'order_attribution',
    'withdrawal',
    'settle_batch',
    'ticket',
  ]);
  expect(errorCodes[42901].headers).toEqual(['Retry-After']);
});

it('retry policy splits by data.reason where 08 §13.11 does', () => {
  expect(errorCodes[50301].retry_kind_by_reason).toEqual({
    maintenance: 'later',
    not_launched: 'never',
  });
  expect(errorCodes[30101].retry_kind_by_reason).toEqual({ auth_unavailable: 'later' });
  expect(errorCodes[30102].retry_kind_by_reason).toEqual({ auth_unavailable: 'later' });
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
  expect(enums.admin_permission).toHaveLength(43);
});

it('identity codes of 08 §13.11 (功能对照补缺 1–3 批) carry their data shapes', () => {
  // 10405 is not a credential failure: 403, so that a 401 interceptor does not clear the session
  // (orchestrator decision j-05; 04 and 08 fix no HTTP status for it).
  expect(errorCodes[10405].http).toBe(403);
  expect(errorCodes[10405].data).toEqual({ min_supported_version: null, reason: ['no_account'] });
  expect(errorCodes[10403].data).toEqual({ reason: ['h5_read_only'] });
  expect(errorCodes[20004].data).toEqual({ reason: ['identity_mismatch'] });
  expect(errorCodes[50305].data).toEqual({ provider: ['wechat', 'apple', 'huawei'] });
  expect(errorCodes[20001].data.reason).toEqual([
    'watch_target_invalid',
    'nickname_sensitive',
    'invalid_device_hash',
    'phone_invalid',
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
