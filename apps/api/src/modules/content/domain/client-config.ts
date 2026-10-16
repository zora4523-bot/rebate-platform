// GET /v1/config (task F1-02c; contract getConfig → Config, 04 §10.1): which config_items keys
// the response is assembled from, the shape each value must have (the contract's schema of the
// part it fills), the keys' planned defaults and the per-caller derivations (platform_status,
// search_status, the two derived flags, agent availability, the h5_release bucket, claim days).
// Pure: values come in as read, the caller supplies the viewer and the link pattern table, and
// every rejected value is reported through `report` (the caller logs it).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import ajvFormats from 'ajv-formats';
import type { Schema } from '@couli/contracts-ts';

export type ClientConfig = Schema<'Config'>;
type PlatformCode = Schema<'PlatformCode'>;
type PurchaseStatus = Schema<'PlatformPurchaseStatus'>;
type SearchStatus = Schema<'PlatformSearchStatus'>;
type HelpLinkTarget = Schema<'HelpLinkTarget'>;

/** Every PlatformCode of the contract: both derived maps cover all of them. */
export const PLATFORM_CODES = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const satisfies readonly PlatformCode[];

/** Keys whose absence or wrong shape fails the whole response (no planned default). */
export const REQUIRED_CONFIG_KEYS = [
  'h5_base_url',
  'h5_release.stable',
  'kf',
  'legal.privacy.version',
  'legal.privacy.min_version',
  'legal.agreement.version',
] as const;

/** Keys that fall back to their default when absent or of the wrong shape. */
const OPTIONAL_CONFIG_KEYS = [
  'h5_release.canary',
  'share_domains',
  'dict_version',
  'features.flags',
  'texts',
  'invite.backfill_hours',
  'invite.bind_phone_guide',
  'invite.before_buy_tip',
  'jump_tip',
  'clipboard',
  'bridge_origins',
  'auth_tips',
  'compliance',
  'display',
  'external_page.nav_host_sample_bp',
  'external_page.union_host_block',
  'earnings.dashboard.enabled',
  'external_hosts',
  'app_update.recheck_interval_sec',
  'help_links',
  'agent.enabled',
  'agent.whitelist_only',
  'agent.whitelist_user_ids',
  'agent.filing_text',
  'agent.examples',
  'agent.guest_daily_quota',
  'agent.require_phone',
  'claim.window_hours',
] as const;

/** Every config_items key GET /v1/config reads (link_patterns is not one: platform's table). */
export const CLIENT_CONFIG_KEYS: readonly string[] = [
  ...REQUIRED_CONFIG_KEYS,
  ...OPTIONAL_CONFIG_KEYS,
  ...PLATFORM_CODES.flatMap((p) => [
    `convert.enabled.${p}`,
    `convert.off_reason.${p}`,
    `search.enabled.${p}`,
  ]),
];

/** The h5_release bucket count: percent_bp is in 1/10000. */
export const H5_BUCKETS = 10_000;
const INT32_MAX = 2_147_483_647;

/** Values as read: a key that has no config_items row is absent from the map. */
export type ConfigValues = ReadonlyMap<string, unknown>;

export interface ConfigViewer {
  readonly appId: string;
  /** null for a guest. */
  readonly userId: string | null;
}

export interface ConfigReport {
  /** A required key is absent or of the wrong shape: the response fails. */
  missing(key: string): void;
  /** An optional key has the wrong shape: its default is used. */
  invalid(key: string): void;
}

export interface ClientConfigInput {
  readonly values: ConfigValues;
  readonly viewer: ConfigViewer;
  /** Guest bucketing subject (the X-Device-Id header), used only when there is no user. */
  readonly deviceId: string | null;
  /** platform's getLinkPatterns(), sent as is. */
  readonly linkPatterns: NonNullable<ClientConfig['link_patterns']>;
  readonly report: ConfigReport;
}

// ---- shape checks (the contract schema of the part each key fills) ----

// The contract's `format: uri`, exactly as ajv-formats (the response validator) reads it.
const isUri = ajvFormats.default.get('uri') as (value: string) => boolean;

type Check<T> = (value: unknown) => value is T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function intIn(min: number, max: number): Check<number> {
  return (value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
const isString: Check<string> = (value): value is string => typeof value === 'string';
const isNonEmptyString: Check<string> = (value): value is string =>
  typeof value === 'string' && value !== '';
const isBoolean: Check<boolean> = (value): value is boolean => typeof value === 'boolean';
const isUriString: Check<string> = (value): value is string =>
  typeof value === 'string' && isUri(value);
const isFreeForm: Check<Record<string, unknown>> = isPlainObject;
function arrayOf<T>(item: Check<T>): Check<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every((v) => item(v));
}
function dictOf<T>(item: Check<T>): Check<Record<string, T>> {
  return (value): value is Record<string, T> =>
    isPlainObject(value) && Object.values(value).every((v) => item(v));
}
const isKf: Check<{ url: string }> = (value): value is { url: string } =>
  isPlainObject(value) && hasExactly(value, ['url']) && isUriString(value['url']);
const isHelpLinkTarget: Check<HelpLinkTarget> = (value): value is HelpLinkTarget =>
  isPlainObject(value) &&
  hasExactly(value, ['route', 'params']) &&
  value['route'] === 'Help' &&
  isPlainObject(value['params']) &&
  hasExactly(value['params'], ['article_id']) &&
  isNonEmptyString(value['params']['article_id']);

interface Canary {
  readonly version: string;
  readonly percent_bp: number;
}
const isCanary: Check<Canary> = (value): value is Canary =>
  isPlainObject(value) &&
  hasExactly(value, ['version', 'percent_bp']) &&
  isNonEmptyString(value['version']) &&
  intIn(0, H5_BUCKETS)(value['percent_bp']);

const isVersion = intIn(1, INT32_MAX);

// ---- derivations ----

/** convert.enabled is on for JSON true or 'on' (the switch reading linking uses too). */
export function isSwitchOn(value: unknown): boolean {
  return value === true || value === 'on';
}

/** on when convert is on; else maintenance only for off_reason exactly 'maintenance'. */
export function purchaseStatus(enabled: unknown, offReason: unknown): PurchaseStatus {
  if (isSwitchOn(enabled)) return 'on';
  return offReason === 'maintenance' ? 'maintenance' : 'not_launched';
}

/** Only JSON true opens search. */
export function searchStatus(enabled: unknown): SearchStatus {
  return enabled === true ? 'on' : 'off';
}

/**
 * Agent availability (BR-ID-03 / BR-AI-12): agent.enabled is JSON true, and either the
 * whitelist is off (only JSON false turns it off) or the user is in the list. A guest is never
 * in the list.
 */
export function agentOpen(input: {
  readonly enabled: unknown;
  readonly whitelistOnly: boolean;
  readonly whitelist: readonly string[];
  readonly userId: string | null;
}): boolean {
  if (input.enabled !== true) return false;
  if (!input.whitelistOnly) return true;
  return input.userId !== null && input.whitelist.includes(input.userId);
}

/**
 * The caller's h5 bucket in [0, 10000): the first 8 bytes of sha256(UTF-8(appId + ':' +
 * subject)) as a big-endian unsigned number, mod 10000.
 */
export function h5Bucket(appId: string, subject: string): number {
  const digest = createHash('sha256').update(`${appId}:${subject}`, 'utf8').digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(H5_BUCKETS));
}

/** claim.window_hours rounded down to days; null below one day or for anything but 1..int32. */
export function windowDays(hours: unknown): number | null {
  if (!intIn(1, INT32_MAX)(hours)) return null;
  const days = Math.floor(hours / 24);
  return days < 1 ? null : days;
}

// ---- assembly ----

/**
 * The Config of one caller, or `undefined` when a required key is absent or of the wrong shape
 * (every such key is reported; the caller answers 50001).
 */
export function buildClientConfig(input: ClientConfigInput): ClientConfig | undefined {
  const { values, viewer, report } = input;
  let failed = false;

  function required<T>(key: string, check: Check<T>): T | undefined {
    const value = values.get(key);
    if (values.has(key) && check(value)) return value;
    report.missing(key);
    failed = true;
    return undefined;
  }
  function optional<T>(key: string, check: Check<T>, fallback: T): T {
    if (!values.has(key)) return fallback;
    const value = values.get(key);
    if (check(value)) return value;
    report.invalid(key);
    return fallback;
  }
  /** A switch read by its own rule; a non-boolean value is reported but still read by the rule. */
  function switchValue(key: string, accepts: (value: unknown) => boolean = isBoolean): unknown {
    if (!values.has(key)) return undefined;
    const value = values.get(key);
    if (!accepts(value)) report.invalid(key);
    return value;
  }

  const h5BaseUrl = required('h5_base_url', isUriString);
  const stable = required('h5_release.stable', isNonEmptyString);
  const kf = required('kf', isKf);
  const privacyVersion = required('legal.privacy.version', isVersion);
  const privacyMin = required('legal.privacy.min_version', isVersion);
  const agreementVersion = required('legal.agreement.version', isVersion);

  // A null canary means "no canary" (not reported); any other wrong shape is reported.
  const canaryValue = values.get('h5_release.canary');
  const canary =
    canaryValue === null || canaryValue === undefined
      ? null
      : optional<Canary | null>('h5_release.canary', isCanary, null);

  const platformStatus = {} as Record<PlatformCode, PurchaseStatus>;
  const searchStatuses = {} as Record<PlatformCode, SearchStatus>;
  for (const platform of PLATFORM_CODES) {
    platformStatus[platform] = purchaseStatus(
      switchValue(`convert.enabled.${platform}`, (v) => isBoolean(v) || v === 'on'),
      switchValue(
        `convert.off_reason.${platform}`,
        (v) => v === 'maintenance' || v === 'not_launched',
      ),
    );
    searchStatuses[platform] = searchStatus(switchValue(`search.enabled.${platform}`));
  }

  const flags: Record<string, boolean> = {
    ...optional('features.flags', dictOf(isBoolean), {}),
    // Derived keys win over a same-named entry of the base dictionary.
    'external_page.union_host_block': switchValue('external_page.union_host_block') !== false,
    'earnings.dashboard.visible': switchValue('earnings.dashboard.enabled') !== false,
  };

  const whitelistOnly = switchValue('agent.whitelist_only') !== false;
  const agent = {
    enabled: agentOpen({
      enabled: switchValue('agent.enabled'),
      whitelistOnly,
      whitelist: optional('agent.whitelist_user_ids', arrayOf(isString), []),
      userId: viewer.userId,
    }),
    whitelist_only: whitelistOnly,
    filing_text: optional('agent.filing_text', isString, ''),
    examples: optional('agent.examples', arrayOf(isString), []),
    guest_daily_quota: optional('agent.guest_daily_quota', intIn(0, INT32_MAX), 3),
    require_phone: switchValue('agent.require_phone') === true,
  };

  const hours = values.get('claim.window_hours');
  if (values.has('claim.window_hours') && hours !== null && !intIn(-INT32_MAX, INT32_MAX)(hours)) {
    report.invalid('claim.window_hours');
  }

  const config: ClientConfig = {
    dict_version: optional('dict_version', isString, '0'),
    h5_base_url: h5BaseUrl ?? '',
    h5_release: { version: releaseVersion(stable ?? '', canary, input) },
    share_domains: optional('share_domains', arrayOf(isString), []),
    features: { flags, platform_status: platformStatus, search_status: searchStatuses },
    texts: optional('texts', dictOf(isString), {}),
    legal: {
      privacy: { version: privacyVersion ?? 1, min_version: privacyMin ?? 1 },
      agreement: { version: agreementVersion ?? 1 },
    },
    invite: {
      // Always false in the MVP (BR-INV-06); never read from config_items.
      required: false,
      backfill_hours: optional('invite.backfill_hours', intIn(0, INT32_MAX), 168),
      bind_phone_guide: optional('invite.bind_phone_guide', isBoolean, true),
      before_buy_tip: optional('invite.before_buy_tip', isBoolean, true),
    },
    agent,
    kf: kf ?? { url: '' },
    jump_tip: optional('jump_tip', isFreeForm, {}),
    clipboard: optional('clipboard', isFreeForm, {}),
    bridge_origins: optional('bridge_origins', isFreeForm, {}),
    auth_tips: optional('auth_tips', isFreeForm, {}),
    compliance: optional('compliance', isFreeForm, {}),
    display: optional('display', isFreeForm, {}),
    external_page: {
      nav_host_sample_bp: optional('external_page.nav_host_sample_bp', intIn(0, H5_BUCKETS), 1000),
    },
    link_patterns: input.linkPatterns,
    external_hosts: optional('external_hosts', arrayOf(isNonEmptyString), []),
    app_update: {
      recheck_interval_sec: optional('app_update.recheck_interval_sec', intIn(1, INT32_MAX), 1800),
    },
    help_links: optional('help_links', dictOf(isHelpLinkTarget), {}),
    claim: { window_days: windowDays(hours) },
  };
  return failed ? undefined : config;
}

/** stable, unless the caller's bucket (user_id, else the guest's device) is below percent_bp. */
function releaseVersion(
  stable: string,
  canary: Canary | null,
  input: Pick<ClientConfigInput, 'viewer' | 'deviceId'>,
): string {
  if (canary === null) return stable;
  const subject = input.viewer.userId ?? input.deviceId;
  if (subject === null || subject === '') return stable;
  return h5Bucket(input.viewer.appId, subject) < canary.percent_bp ? canary.version : stable;
}
