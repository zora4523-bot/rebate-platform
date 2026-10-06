// Case table of the bridge conformance page (规划/03 §5.5). Methods, levels, models, timeouts,
// `since`, gesture flags, error codes and target apps come from the generated contract
// (@couli/contracts-ts); parameter shapes come from contracts/bridge.schema.json. Nothing here
// keeps its own method catalogue: the constants below only hold probe values and the
// side-effect rule that decides which normal calls wait for a tap.
import { bridge } from '@couli/contracts-ts';
import type {
  CaseExpectation,
  CaseTrigger,
  ConformanceCase,
  ConformancePlatform,
} from './model.ts';

type MethodName = bridge.BridgeMethodName;
type MethodMeta = (typeof bridge.bridgeMethods)[MethodName];

/** The three App platforms, in the order of the contract's `since` keys. */
const ENV_SINCE = bridge.bridgeMethods['app.getEnv'].since;
export const PLATFORMS = Object.keys(ENV_SINCE) as ConformancePlatform[];

export function isPlatform(value: unknown): value is ConformancePlatform {
  return (PLATFORMS as readonly unknown[]).includes(value);
}

interface JsonSchema {
  $ref?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
}

interface RawBridgeSchema {
  methods: Record<string, { params: JsonSchema }>;
  $defs: Record<string, JsonSchema>;
}

// The raw schema stays outside this package's TypeScript project (as in shared/texts.ts); Vite and
// Vitest inline it. Only parameter `required` / `properties` / `type` are read from it.
const loadedSchema = import.meta.glob<RawBridgeSchema>(
  '../../../../../contracts/bridge.schema.json',
  { eager: true, import: 'default' },
);

function rawSchema(): RawBridgeSchema {
  const schema = Object.values(loadedSchema)[0];
  if (schema === undefined) throw new Error('conformance: contracts/bridge.schema.json is missing');
  return schema;
}

/** Subframe probe (负面用例 ②): the only row whose expectation is "any failure". */
export const FRAME_CASE_ID = 'frame/negative/subframe';
const FRAME_METHOD: MethodName = 'app.getEnv';

/** contracts/bridge.schema.json gesture_required: last 1 second, plus a 100 ms margin. */
export const NO_GESTURE_WAIT_MS = 1100;

/** A method name the contract does not have; the SDK must answer 90001 without native. */
const UNKNOWN_METHOD = 'conformance.notAMethod';

/**
 * Methods whose valid call changes something outside the page (navigation, jumps, sharing,
 * permissions, saved files, persistent settings, signed server calls, blocking overlays). Their
 * normal case is `tap`, never run on load. Whole namespaces cover methods added later.
 */
const SIDE_EFFECT_NAMESPACES: readonly string[] = ['trade.', 'ext.'];
const SIDE_EFFECT_METHODS: readonly MethodName[] = [
  'auth.login',
  'clipboard.setAutoDetect',
  'clipboard.write',
  'cs.open',
  'media.previewImage',
  'media.saveImage',
  'nav.close',
  'nav.open',
  'net.signedRequest',
  'perm.request',
  'share.open',
  'ui.showLoading',
];

function hasSideEffect(method: string): boolean {
  return (
    (SIDE_EFFECT_METHODS as readonly string[]).includes(method) ||
    SIDE_EFFECT_NAMESPACES.some((prefix) => method.startsWith(prefix))
  );
}

// Probe values. Addresses use example.com unless a contract sample names the host.
const PROBE_TEXT = 'conformance';
const PROBE_KEY = 'conformance-probe';
const PROBE_PAGE_URL = 'https://example.com/conformance';
const PROBE_IMAGE_URL = 'https://example.com/conformance.png';
const PROBE_PLATFORM = 'taobao';

/**
 * Hosts of the platform link-pattern sample in contracts/openapi.yaml (ConfigResponse example,
 * link_patterns.rules[].hosts). Native matches against the live /v1/config; the UI suites load
 * that sample, so the page never invents a real shopping-platform domain.
 */
const PLATFORM_LINK_SAMPLE_HOSTS: readonly string[] = ['taobao.example.test'];

/**
 * Share domains of the same ConfigResponse example in contracts/openapi.yaml (share_domains).
 * share.open lets a share domain through only on a share page path (sharePagePaths); a path no
 * share page can ever use must be refused with 90403 even while every path_pattern is null.
 */
const SHARE_DOMAIN_SAMPLE_HOSTS: readonly string[] = ['s.example.test'];
/** Reserved path, chosen so it cannot collide with any share page path. */
const NOT_SHARE_PAGE_PATH = '/__conformance_not_a_share_page__';

/** 90403 variants of one blocked platform address (负面用例 ④). */
function platformLinkVariants(host: string): { variant: string; url: string }[] {
  return [
    { variant: 'base', url: `https://${host}/` },
    { variant: 'host_case', url: `https://${host.toUpperCase()}/` },
    { variant: 'trailing_dot', url: `https://${host}./` },
    { variant: 'default_port', url: `https://${host}:443/` },
    {
      variant: 'percent_host',
      url: `https://%${host.charCodeAt(0).toString(16)}${host.slice(1)}/`,
    },
    { variant: 'percent_path', url: `https://${host}/%70roduct` },
  ];
}

const [signedPath] = bridge.signedPaths;

/** One valid parameter set per contract method; the mapped type fails to compile on drift. */
const VALID_PARAMS: { readonly [M in MethodName]: bridge.BridgeMethods[M]['params'] } = {
  'app.getEnv': {},
  'app.getConfig': { keys: ['features'] },
  'auth.getUser': {},
  'auth.login': {},
  'auth.getH5Token': {},
  'net.signedRequest': { method: signedPath.method, path: signedPath.path, body: {} },
  'ui.toast': { text: PROBE_TEXT },
  'ui.showLoading': { text: PROBE_TEXT },
  'ui.hideLoading': {},
  'ui.setNavBar': { visible: true },
  'nav.open': { route: 'Home' },
  'nav.close': {},
  'trade.openProduct': { platform: PROBE_PLATFORM, product_key: PROBE_KEY },
  'trade.convertAndOpen': { platform: PROBE_PLATFORM, product_key: PROBE_KEY },
  'trade.authorize': { platform: PROBE_PLATFORM },
  'trade.openUnionActivity': { platform: PROBE_PLATFORM, activity_id: PROBE_KEY },
  'share.open': { content: { type: 'image', images: [PROBE_IMAGE_URL] } },
  'media.saveImage': { urls: [PROBE_IMAGE_URL] },
  'media.previewImage': { urls: [PROBE_IMAGE_URL] },
  'clipboard.write': { text: PROBE_TEXT },
  'clipboard.read': {},
  'clipboard.setAutoDetect': { enabled: false },
  'ext.openApp': { target: firstAppTarget(), url: PROBE_PAGE_URL },
  'ext.openBrowser': { url: PROBE_PAGE_URL },
  'ext.openMiniProgram': { app_id: PROBE_KEY },
  'cs.open': { entry: PROBE_TEXT },
  'perm.getPushStatus': {},
  'perm.request': { type: 'push' },
  'track.event': { name: 'conformance_probe' },
  'media.scan': {},
  'media.uploadImage': {},
};

/** First target ext.openApp may actually open; null while every target is trade_only. */
function openableAppTarget(): bridge.AppTarget | null {
  const found = Object.entries(bridge.apps).find(([, app]) => !app.trade_only);
  return found === undefined ? null : (found[0] as bridge.AppTarget);
}

/** Schema-valid target for the non-normal ext.openApp probes (timeout, login, ...). */
function firstAppTarget(): bridge.AppTarget {
  const openable = openableAppTarget();
  if (openable !== null) return openable;
  const [target] = Object.keys(bridge.apps) as bridge.AppTarget[];
  if (target === undefined) throw new Error('conformance: contracts/apps.json has no target');
  return target;
}

function resolve(schema: JsonSchema): JsonSchema {
  if (schema.$ref === undefined) return schema;
  const referenced = rawSchema().$defs[schema.$ref.replace('#/$defs/', '')];
  if (referenced === undefined) throw new Error(`conformance: unresolved ${schema.$ref}`);
  return resolve(referenced);
}

function paramSchema(method: string): JsonSchema {
  const entry = rawSchema().methods[method];
  if (entry === undefined) throw new Error(`conformance: no params schema for ${method}`);
  return entry.params;
}

function hasParams(method: string): boolean {
  return Object.keys(paramSchema(method).properties ?? {}).length > 0;
}

/**
 * Parameters that break the method's own schema: the first required field removed, or, when
 * nothing is required, the first declared property given a value of another JSON type.
 */
function badParams(method: MethodName): Record<string, unknown> {
  const schema = paramSchema(method);
  const params: Record<string, unknown> = { ...VALID_PARAMS[method] };
  const [required] = schema.required ?? [];
  if (required !== undefined) {
    Reflect.deleteProperty(params, required);
    return params;
  }
  const [first] = Object.entries(schema.properties ?? {});
  const declared = first === undefined ? undefined : resolve(first[1]).type;
  if (first === undefined || declared === undefined) {
    // additionalProperties is false on every params object of the contract.
    params['conformance_unexpected'] = true;
    return params;
  }
  params[first[0]] = declared === 'string' ? 0 : PROBE_TEXT;
  return params;
}

interface CaseEntry {
  testCase: ConformanceCase;
  params: unknown;
}

function entry(
  method: string,
  category: ConformanceCase['category'],
  variant: string | null,
  expect: CaseExpectation,
  trigger: CaseTrigger,
  params: unknown,
  platforms: readonly ConformancePlatform[] | null = limitedPlatforms(method),
): CaseEntry {
  const id = variant === null ? `${method}/${category}` : `${method}/${category}/${variant}`;
  const testCase: ConformanceCase = { id, method, category, expect, trigger };
  if (platforms !== null) testCase.platforms = [...platforms];
  return { testCase, params };
}

function sinceOf(method: string): MethodMeta['since'] | null {
  return Object.hasOwn(bridge.bridgeMethods, method)
    ? bridge.bridgeMethods[method as MethodName].since
    : null;
}

/**
 * Platforms whose `since` is set, when only some are: rows of such a method run only there.
 * null = no limit (every platform supports it, or none does, or the contract lacks the method).
 */
function limitedPlatforms(method: string): ConformancePlatform[] | null {
  const since = sinceOf(method);
  if (since === null) return null;
  const supported = PLATFORMS.filter((platform) => since[platform] !== null);
  return supported.length === 0 || supported.length === PLATFORMS.length ? null : supported;
}

/** L2 methods and gesture_required methods need a user tap shortly before the call. */
function isGestureMeta(meta: MethodMeta): boolean {
  return meta.level === 'L2' || meta.gesture_required === true;
}

/** Whether a contract method needs a user gesture; false for names the contract lacks. */
export function needsGesture(method: string): boolean {
  return Object.hasOwn(bridge.bridgeMethods, method)
    ? isGestureMeta(bridge.bridgeMethods[method as MethodName])
    : false;
}

/** The contract's reply timeout of a method; null when it has none or the method is unknown. */
export function contractTimeoutMs(method: string): number | null {
  return Object.hasOwn(bridge.bridgeMethods, method)
    ? bridge.bridgeMethods[method as MethodName].timeout_ms
    : null;
}

function methodEntries(method: MethodName, meta: MethodMeta): CaseEntry[] {
  const valid = VALID_PARAMS[method];
  const missing = PLATFORMS.filter((platform) => meta.since[platform] === null);
  if (missing.length === PLATFORMS.length) {
    return [entry(method, 'unsupported', null, { code: 90001 }, 'auto', valid)];
  }
  // Platforms without the method: native must not declare it, so the SDK answers 90001 there.
  const rows: CaseEntry[] = missing.map((platform) =>
    entry(method, 'unsupported', platform, { code: 90001 }, 'auto', valid, [platform]),
  );
  const gesture = isGestureMeta(meta);
  const normalTrigger: CaseTrigger = gesture || hasSideEffect(method) ? 'tap' : 'auto';
  // Native checks login → gesture (90404) → params (90002): without a tap a gesture method
  // answers 90404 before it ever looks at the bad params.
  const badParamsTrigger: CaseTrigger = gesture ? 'tap' : 'auto';
  // ext.openApp answers 90403 for trade_only targets, so its normal needs a target that is not.
  if (method !== 'ext.openApp' || openableAppTarget() !== null) {
    rows.push(entry(method, 'normal', null, { ok: true }, normalTrigger, valid));
  }
  if (meta.model === 'async' && meta.timeout_ms !== null) {
    rows.push(entry(method, 'timeout', null, { code: 90003 }, 'harness', valid));
  }
  if (hasParams(method)) {
    const bad = badParams(method);
    rows.push(entry(method, 'bad_params', null, { code: 90002 }, badParamsTrigger, bad));
  }
  if (gesture) rows.push(entry(method, 'no_gesture', null, { code: 90404 }, 'auto', valid));
  if (meta.level === 'L1' || meta.level === 'L2') {
    rows.push(entry(method, 'negative', 'logged_out', { code: 90401 }, 'harness', valid));
  }
  return rows;
}

/**
 * 负面用例 ④: ext.openApp to trade_only targets; platform addresses to openBrowser / share;
 * a non-share-page path on a share domain to share.open.
 */
function whitelistEntries(): CaseEntry[] {
  const rows: CaseEntry[] = [];
  for (const [target, app] of Object.entries(bridge.apps)) {
    if (!app.trade_only) continue;
    const variant = `trade_only/${target}`;
    const params = { target, url: PROBE_PAGE_URL };
    rows.push(entry('ext.openApp', 'negative', variant, { code: 90403 }, 'auto', params));
  }
  for (const host of PLATFORM_LINK_SAMPLE_HOSTS) {
    for (const { variant, url } of platformLinkVariants(host)) {
      const name = `platform_link/${host}/${variant}`;
      rows.push(entry('ext.openBrowser', 'negative', name, { code: 90403 }, 'auto', { url }));
      const share = { content: { type: 'link', url, title: PROBE_TEXT } };
      rows.push(entry('share.open', 'negative', name, { code: 90403 }, 'auto', share));
    }
  }
  for (const host of SHARE_DOMAIN_SAMPLE_HOSTS) {
    const url = `https://${host}${NOT_SHARE_PAGE_PATH}`;
    const name = `share_domain/${host}/not_share_page`;
    const share = { content: { type: 'link', url, title: PROBE_TEXT } };
    rows.push(entry('share.open', 'negative', name, { code: 90403 }, 'auto', share));
  }
  return rows;
}

/** Code-unit order, the same as Array.prototype.sort() on the ids. */
function byId(a: CaseEntry, b: CaseEntry): number {
  if (a.testCase.id === b.testCase.id) return 0;
  return a.testCase.id < b.testCase.id ? -1 : 1;
}

let memo: CaseEntry[] | undefined;

function entries(): CaseEntry[] {
  if (memo !== undefined) return memo;
  const methods = Object.entries(bridge.bridgeMethods) as [MethodName, MethodMeta][];
  const rows: CaseEntry[] = [
    ...methods.flatMap(([method, meta]) => methodEntries(method, meta)),
    entry(UNKNOWN_METHOD, 'unsupported', null, { code: 90001 }, 'auto', {}),
    ...whitelistEntries(),
    {
      testCase: {
        id: FRAME_CASE_ID,
        method: FRAME_METHOD,
        category: 'negative',
        expect: { ok: false },
        trigger: 'auto',
      },
      params: VALID_PARAMS[FRAME_METHOD],
    },
  ];
  rows.sort(byId);
  const ids = new Set(rows.map((row) => row.testCase.id));
  if (ids.size !== rows.length) throw new Error('conformance: duplicate case id');
  memo = rows;
  return rows;
}

function copyCase(testCase: ConformanceCase): ConformanceCase {
  const copy: ConformanceCase = { ...testCase, expect: { ...testCase.expect } };
  if (testCase.platforms !== undefined) copy.platforms = [...testCase.platforms];
  return copy;
}

/** Build metadata from bridgeMethods and parameter schemas, including contract-backed negatives. */
export function buildCaseTable(): ConformanceCase[] {
  return entries().map((row) => copyCase(row.testCase));
}

/** Params stay outside the public result object. */
export function paramsForCase(testCase: ConformanceCase): unknown {
  const found = entries().find((row) => row.testCase.id === testCase.id);
  if (found === undefined) throw new Error(`conformance: unknown case ${testCase.id}`);
  return structuredClone(found.params);
}

function runsOn(row: ConformanceCase, platform: ConformancePlatform | null): boolean {
  if (row.platforms === undefined) return true;
  return platform !== null && row.platforms.includes(platform);
}

/**
 * Rows that may run on `platform`: unrestricted rows always; platform-limited rows only once the
 * page knows the platform (app.getEnv) and it is listed.
 */
export function casesForPlatform<T extends ConformanceCase>(
  cases: readonly T[],
  platform: ConformancePlatform | null,
): T[] {
  return cases.filter((row) => runsOn(row, platform));
}

/** No cases query retains harness rows as pending; an explicit query selects only its IDs. */
export function selectCases(
  cases: readonly ConformanceCase[],
  search: string,
): { cases: ConformanceCase[]; unknown_cases: string[] } {
  const query = new URLSearchParams(search);
  const raw = query.get('cases');
  if (raw === null) return { cases: [...cases], unknown_cases: [] };
  const ids = raw.split(',').map((id) => id.trim());
  const wanted = [...new Set(ids.filter((id) => id !== ''))];
  const known = new Set(cases.map((row) => row.id));
  const selected = new Set(wanted);
  return {
    cases: cases.filter((row) => selected.has(row.id)),
    unknown_cases: wanted.filter((id) => !known.has(id)),
  };
}
