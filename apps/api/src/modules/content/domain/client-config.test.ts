import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  agentOpen,
  buildClientConfig,
  CLIENT_CONFIG_KEYS,
  h5Bucket,
  PLATFORM_CODES,
  purchaseStatus,
  searchStatus,
  windowDays,
  type ClientConfig,
} from './client-config.ts';

const REQUIRED = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable-v1',
  kf: { url: 'https://kf.example.test/chat' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
};
const PATTERNS = { version: 'lp-1', rules: [] } as NonNullable<ClientConfig['link_patterns']>;

function build(
  extra: Record<string, unknown> = {},
  viewer: { appId: string; userId: string | null } = { appId: 'app', userId: null },
  deviceId: string | null = null,
) {
  const missing: string[] = [];
  const invalid: string[] = [];
  const config = buildClientConfig({
    values: new Map(Object.entries({ ...REQUIRED, ...extra })),
    viewer,
    deviceId,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: (k) => missing.push(k), invalid: (k) => invalid.push(k) },
  });
  return { config, missing, invalid };
}

it('[AC-F1-02c] minimal configuration gets every planned default', () => {
  const { config, missing, invalid } = build({ 'invite.required': true });
  expect(missing).toEqual([]);
  expect(invalid).toEqual([]);
  expect(config).toMatchObject({
    dict_version: '0',
    h5_release: { version: 'stable-v1' },
    invite: { required: false, backfill_hours: 168, bind_phone_guide: true, before_buy_tip: true },
    agent: { enabled: false, whitelist_only: true, guest_daily_quota: 3, require_phone: false },
    external_page: { nav_host_sample_bp: 1000 },
    app_update: { recheck_interval_sec: 1800 },
    claim: { window_days: null },
    link_patterns: PATTERNS,
  });
  expect(Object.keys(config!.features.platform_status)).toEqual([...PLATFORM_CODES]);
});

it('[AC-F1-02c] a required key absent or malformed fails and is reported', () => {
  for (const [key, value] of [
    ['h5_base_url', 'relative/path'],
    ['kf', { url: 'https://kf.example.test', extra: true }],
    ['legal.privacy.version', 0],
    ['h5_release.stable', ''],
  ] as const) {
    const { config, missing } = build({ [key]: value });
    expect(config).toBeUndefined();
    expect(missing).toEqual([key]);
  }
  const missing: string[] = [];
  const result = buildClientConfig({
    values: new Map(),
    viewer: { appId: 'app', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: [],
    report: { missing: (k) => missing.push(k), invalid: () => undefined },
  });
  expect(result).toBeUndefined();
  expect(missing).toHaveLength(6);
});

it('[AC-F1-02c] dictionaries and arrays are judged whole; malformed optional values warn', () => {
  const { config, invalid } = build({
    texts: { ok: 'a', bad: 7 },
    help_links: { bad: { route: 'Home', params: { article_id: 'x' } } },
    external_hosts: ['a.example.test', ''],
    jump_tip: [],
  });
  expect(config).toMatchObject({ texts: {}, help_links: {}, external_hosts: [], jump_tip: {} });
  expect(invalid).toEqual(expect.arrayContaining(['texts', 'help_links', 'external_hosts']));
});

it('[AC-F1-02c] derived flags win over the base dictionary', () => {
  const { config } = build({
    'features.flags': { 'external_page.union_host_block': false, custom: true },
    'earnings.dashboard.enabled': false,
  });
  expect(config!.features.flags).toEqual({
    custom: true,
    'external_page.union_host_block': true,
    'earnings.dashboard.visible': false,
  });
});

it('[AC-F1-02c] platform and search status read their own switch rules', () => {
  expect(purchaseStatus('on', 'maintenance')).toBe('on');
  expect(purchaseStatus(1, 'maintenance')).toBe('maintenance');
  expect(purchaseStatus(false, 'other')).toBe('not_launched');
  expect(searchStatus('on')).toBe('off');
  expect(searchStatus(true)).toBe('on');
});

it('[AC-F1-02c] agent availability: master switch, whitelist and guests', () => {
  const base = { enabled: true, whitelistOnly: true, whitelist: ['u1'] };
  expect(agentOpen({ ...base, userId: null })).toBe(false);
  expect(agentOpen({ ...base, userId: 'u1' })).toBe(true);
  expect(agentOpen({ ...base, userId: 'u2' })).toBe(false);
  expect(agentOpen({ ...base, whitelistOnly: false, userId: null })).toBe(true);
  expect(agentOpen({ ...base, enabled: 'on', userId: 'u1' })).toBe(false);
  const { config } = build(
    { 'agent.enabled': true, 'agent.whitelist_user_ids': ['u1', 7] },
    { appId: 'app', userId: 'u1' },
  );
  expect(config!.agent.enabled).toBe(false);
});

it('[AC-F1-02c] h5 bucket follows the sha256 formula and includes the app id', () => {
  const hex = createHash('sha256').update('app:subject').digest('hex');
  expect(h5Bucket('app', 'subject')).toBe(Number(BigInt(`0x${hex.slice(0, 16)}`) % 10_000n));
  const canary = { 'h5_release.canary': { version: 'c', percent_bp: 10_000 } };
  expect(build(canary).config!.h5_release).toEqual({ version: 'stable-v1' });
  expect(build(canary, { appId: 'app', userId: null }, 'dev').config!.h5_release).toEqual({
    version: 'c',
  });
  const zero = { 'h5_release.canary': { version: 'c', percent_bp: 0 } };
  expect(build(zero, { appId: 'app', userId: 'u' }).config!.h5_release).toEqual({
    version: 'stable-v1',
  });
  const bad = build({ 'h5_release.canary': { version: 'c' } }, { appId: 'a', userId: 'u' });
  expect(bad.config!.h5_release).toEqual({ version: 'stable-v1' });
  expect(bad.invalid).toContain('h5_release.canary');
  expect(build({ 'h5_release.canary': null }).invalid).toEqual([]);
});

it('[AC-F1-02c] the user id, not the device, buckets a logged-in caller', () => {
  const user = 'user-1';
  const percent = h5Bucket('app', user) + 1;
  const canary = { 'h5_release.canary': { version: 'c', percent_bp: percent } };
  for (const device of [null, 'device-a', 'device-b']) {
    expect(build(canary, { appId: 'app', userId: user }, device).config!.h5_release).toEqual({
      version: 'c',
    });
  }
});

it('[AC-F1-02c] claim window rounds down to days and is null otherwise', () => {
  expect(windowDays(47)).toBe(1);
  expect(windowDays(48)).toBe(2);
  expect(windowDays(23)).toBeNull();
  expect(windowDays(36.5)).toBeNull();
  expect(windowDays('48')).toBeNull();
  expect(windowDays(0)).toBeNull();
  expect(windowDays(2_147_483_648)).toBeNull();
});

it('[AC-F1-02c] the key list covers every platform switch once', () => {
  expect(new Set(CLIENT_CONFIG_KEYS).size).toBe(CLIENT_CONFIG_KEYS.length);
  expect(CLIENT_CONFIG_KEYS).toContain('search.enabled.suning');
  expect(CLIENT_CONFIG_KEYS).not.toContain('link_patterns');
  expect(CLIENT_CONFIG_KEYS).not.toContain('invite.required');
});

it('[AC-F1-02h] lkg_max_age_sec and bridge_disabled_methods default silently when absent', () => {
  const { config, invalid } = build();
  expect(config!.lkg_max_age_sec).toBe(604_800);
  expect(config!.bridge_disabled_methods).toEqual([]);
  expect(config!.features.rank_platforms).toEqual([]);
  expect(invalid).toEqual([]);
});

it('[AC-F1-02h] the namespaced keys are read; same-named keys are ignored', () => {
  const { config } = build({
    'config.lkg_max_age_sec': 3600,
    'bridge.disabled_methods': ['ext.openApp', 'clipboard.read'],
    lkg_max_age_sec: 1,
    bridge_disabled_methods: ['a.b'],
  });
  expect(config!.lkg_max_age_sec).toBe(3600);
  expect(config!.bridge_disabled_methods).toEqual(['ext.openApp', 'clipboard.read']);
});

it('[AC-F1-02h] a malformed lkg_max_age_sec falls back whole and is reported', () => {
  for (const value of [0, -1, 1.5, '3600', 2_147_483_648, null]) {
    const { config, invalid } = build({ 'config.lkg_max_age_sec': value });
    expect(config!.lkg_max_age_sec).toBe(604_800);
    expect(invalid).toEqual(['config.lkg_max_age_sec']);
  }
});

it('[AC-F1-02h] a malformed bridge.disabled_methods falls back to [] and is reported', () => {
  for (const value of [
    ['login'],
    ['clipboard.read', 7],
    ['a.b', 'a.b'],
    'clipboard.read',
    ['Clipboard.read'],
    ['clipboard.read.extra'],
    {},
  ]) {
    const { config, invalid } = build({ 'bridge.disabled_methods': value });
    expect(config!.bridge_disabled_methods).toEqual([]);
    expect(invalid).toEqual(['bridge.disabled_methods']);
  }
});

it('[AC-F1-02h] features.rank_platforms comes from the input, never from config rows', () => {
  const missing: string[] = [];
  const config = buildClientConfig({
    values: new Map(
      Object.entries({
        ...REQUIRED,
        'features.rank_platforms': ['taobao'],
        'features.flags': { rank_platforms: true },
      }),
    ),
    viewer: { appId: 'app', userId: null },
    deviceId: null,
    linkPatterns: PATTERNS,
    rankPlatforms: ['jd', 'pdd'],
    report: { missing: (k) => missing.push(k), invalid: () => undefined },
  });
  expect(config!.features.rank_platforms).toEqual(['jd', 'pdd']);
  expect(missing).toEqual([]);
});
