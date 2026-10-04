// Reads contracts/bridge.schema.json, contracts/routes.json and contracts/apps.json (CT-03), checks
// their shape and their agreement with contracts/enums, contracts/error-codes.yaml and
// contracts/openapi.yaml, and renders src/bridge.gen.ts (types through openapi-typescript).
import { readFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef, ErrorRangeDef } from './catalog.ts';
import { join } from 'node:path';
import { appsFile, bridgeFile, openapiFile, repoRoot, routesFile } from './paths.ts';

type Obj = Record<string, unknown>;
type Since = { ios: string | null; android: string | null; harmony: string | null };

export type BridgeMethodDef = {
  name: string;
  level: 'L0' | 'L1' | 'L2';
  model: 'sync' | 'async';
  timeout_ms: number | null;
  phase: string;
  since: Since;
  params: Obj;
  result: Obj;
};
export type RouteDef = {
  name: string;
  kind: 'native' | 'h5';
  h5_path: string | null;
  auth: string;
  since: Since;
  phase: string;
  debug_only: boolean;
  entry: string[];
  params: Obj;
};
export type AppDef = {
  name: string;
  platform: string;
  status: string;
  trade_only: boolean;
  ios_query_schemes: string[];
};
export type SdkQueryDef = {
  source_sdk: string;
  ios_scheme: string | null;
  android_package: string | null;
  harmony_scheme: string | null;
};
export type InboundDef =
  | {
      kind: 'custom_scheme';
      purpose: string;
      source_sdk: string | null;
      platforms: string[];
      scheme: string;
    }
  | {
      kind: 'verified_link';
      purpose: string;
      source_sdk: string | null;
      platforms: string[];
      host: string;
      path_prefix: string;
      verified: true;
    };
export type BridgeCatalog = {
  bridge: Obj;
  methods: BridgeMethodDef[];
  events: Array<{ name: string; data: Obj }>;
  signedPaths: Array<{ method: string; path: string }>;
  errors: number[];
  routes: RouteDef[];
  apps: AppDef[];
  sdkQueries: SdkQueryDef[];
  inbound: InboundDef[];
};

const NAMESPACES = [
  'app',
  'auth',
  'ui',
  'nav',
  'trade',
  'share',
  'media',
  'clipboard',
  'ext',
  'cs',
  'perm',
  'track',
  'net',
];
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ROUTE_NAME = /^[A-Z][A-Za-z0-9]*$/;
const PLATFORMS = ['ios', 'android', 'harmony'] as const;
const MAX_IOS_QUERY_SCHEMES = 20;

class BridgeError extends Error {}

function fail(where: string, message: string): never {
  throw new BridgeError(`${where}: ${message}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(file: string, label: string): Obj {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
  if (!isObj(doc)) fail(label, 'must be a JSON object');
  if (doc['version'] !== 1) fail(label, 'version must be 1');
  return doc;
}

function since(where: string, value: unknown): Since {
  if (!isObj(value)) fail(where, 'since must be {ios, android, harmony}');
  for (const key of Object.keys(value)) {
    if (!(PLATFORMS as readonly string[]).includes(key)) fail(where, `since: unknown key ${key}`);
  }
  const out = {} as Since;
  for (const p of PLATFORMS) {
    const v = value[p];
    if (v !== null && (typeof v !== 'string' || !SEMVER.test(v))) {
      fail(where, `since.${p} must be a SemVer string or null`);
    }
    out[p] = v;
  }
  return out;
}

function closedObjectSchema(where: string, value: unknown): Obj {
  if (!isObj(value) || value['type'] !== 'object' || value['additionalProperties'] !== false) {
    fail(where, 'must be a JSON Schema with type object and additionalProperties false');
  }
  const props = value['properties'];
  const required = value['required'];
  if (!isObj(props) || !Array.isArray(required)) fail(where, 'properties and required are needed');
  for (const r of required) {
    if (typeof r !== 'string' || !(r in props))
      fail(where, `required ${String(r)} is not a property`);
  }
  return value;
}

function at(root: unknown, pointer: string): unknown {
  let cur = root;
  for (const part of pointer.split('/')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function enumOf(where: string, schema: unknown): unknown[] {
  if (!isObj(schema) || !Array.isArray(schema['enum'])) fail(where, 'enum expected');
  return schema['enum'];
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

const CLIENT_SIDES = ['ios', 'android', 'harmony'];
const baselineFile = join(repoRoot, 'specs', 'client-security-baseline.yaml');

function optString(where: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || v === '') fail(where, 'must be a non-empty string or null');
  return v;
}

function loadSdkQueries(value: unknown): SdkQueryDef[] {
  const where = 'contracts/apps.json sdk_queries';
  if (!Array.isArray(value)) fail(where, 'must be a list');
  return value.map((q, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(q)) fail(w, 'must be an object');
    const keys = ['source_sdk', 'ios_scheme', 'android_package', 'harmony_scheme'];
    if (Object.keys(q).some((k) => !keys.includes(k)) || keys.some((k) => !(k in q))) {
      fail(w, `exactly the keys ${keys.join(', ')}`);
    }
    const source = q['source_sdk'];
    if (typeof source !== 'string' || source === '')
      fail(w, 'source_sdk must be a non-empty string');
    return {
      source_sdk: source,
      ios_scheme: optString(`${w} ios_scheme`, q['ios_scheme']),
      android_package: optString(`${w} android_package`, q['android_package']),
      harmony_scheme: optString(`${w} harmony_scheme`, q['harmony_scheme']),
    };
  });
}

/** Inbound callbacks (04 §9, 03 §4.5, CSB-11 of specs/client-security-baseline.yaml). */
function loadInbound(value: unknown, apps: AppDef[], sdkQueries: SdkQueryDef[]): InboundDef[] {
  const where = 'contracts/apps.json inbound';
  if (!Array.isArray(value)) fail(where, 'must be a list');
  const baseline = parseYamlLite(readFileSync(baselineFile, 'utf8'));
  const forbidden =
    isObj(baseline) && Array.isArray(baseline['forbidden_schemes'])
      ? (baseline['forbidden_schemes'] as unknown[]).map((s) => String(s).toLowerCase())
      : fail('specs/client-security-baseline.yaml', 'forbidden_schemes missing');
  const ownHosts =
    isObj(baseline) && Array.isArray(baseline['own_link_hosts'])
      ? (baseline['own_link_hosts'] as unknown[]).map((h) => String(h))
      : fail('specs/client-security-baseline.yaml', 'own_link_hosts missing');
  const thirdParty = [
    ...apps.flatMap((a) => a.ios_query_schemes),
    ...sdkQueries.flatMap((q) => [q.ios_scheme, q.harmony_scheme].filter((s) => s !== null)),
  ].map((s) => String(s).toLowerCase());
  return value.map((e, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(e)) fail(w, 'must be an object');
    const purpose = e['purpose'];
    if (typeof purpose !== 'string' || purpose === '')
      fail(w, 'purpose must be a non-empty string');
    const source = optString(`${w} source_sdk`, e['source_sdk']);
    const platforms = e['platforms'];
    if (
      !Array.isArray(platforms) ||
      platforms.length === 0 ||
      platforms.some((p) => typeof p !== 'string' || !CLIENT_SIDES.includes(p)) ||
      new Set(platforms).size !== platforms.length
    ) {
      fail(w, 'platforms: non-empty, distinct, each ios | android | harmony');
    }
    const common = ['kind', 'purpose', 'source_sdk', 'platforms'];
    if (e['kind'] === 'custom_scheme') {
      if (Object.keys(e).some((k) => ![...common, 'scheme'].includes(k))) {
        fail(w, 'custom_scheme has only kind, purpose, source_sdk, platforms, scheme');
      }
      const scheme = e['scheme'];
      if (typeof scheme !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
        fail(w, 'scheme must be a URI scheme');
      }
      const lower = scheme.toLowerCase();
      if (forbidden.includes(lower))
        fail(w, `scheme ${scheme} is a system or generic scheme (CSB-11)`);
      if (thirdParty.includes(lower)) {
        fail(w, `scheme ${scheme} equals a target or SDK query scheme (CSB-11)`);
      }
      return { kind: 'custom_scheme', purpose, source_sdk: source, platforms, scheme };
    }
    if (e['kind'] === 'verified_link') {
      if (Object.keys(e).some((k) => ![...common, 'host', 'path_prefix', 'verified'].includes(k))) {
        fail(
          w,
          'verified_link has only kind, purpose, source_sdk, platforms, host, path_prefix, verified',
        );
      }
      const host = e['host'];
      if (typeof host !== 'string' || host === '' || host.includes('*') || host.includes('/')) {
        fail(w, 'host must be a full host name without wildcard');
      }
      if (!ownHosts.includes(host)) fail(w, `host ${host} is not in own_link_hosts (CSB-11)`);
      const prefix = e['path_prefix'];
      if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix === '/') {
        fail(w, 'path_prefix starts with / and is not just /');
      }
      if (e['verified'] !== true) fail(w, 'verified must be true');
      return {
        kind: 'verified_link',
        purpose,
        source_sdk: source,
        platforms,
        host,
        path_prefix: prefix,
        verified: true,
      };
    }
    return fail(w, 'kind: custom_scheme | verified_link');
  });
}

export function loadBridgeCatalog(
  enums: readonly EnumDef[],
  ranges: readonly ErrorRangeDef[],
): BridgeCatalog {
  const enumValues = new Map(enums.map((e) => [e.name, e.values.map((v) => v.value)]));
  const want = (name: string): string[] => enumValues.get(name) ?? fail('enums', `${name} missing`);

  // apps.json
  const appsDoc = readJson(appsFile, 'contracts/apps.json');
  if (!isObj(appsDoc['apps'])) fail('contracts/apps.json', 'apps must be an object');
  const apps: AppDef[] = [];
  for (const [name, def] of Object.entries(appsDoc['apps'])) {
    const where = `contracts/apps.json ${name}`;
    if (!isObj(def)) fail(where, 'must be an object');
    const platform = def['platform'];
    if (typeof platform !== 'string' || !want('platform').includes(platform)) {
      fail(where, 'platform must be a contracts/enums platform');
    }
    const status = def['status'];
    if (status !== 'candidate' && status !== 'verified')
      fail(where, 'status: candidate | verified');
    const ios = def['ios'];
    const schemes = isObj(ios) ? ios['query_schemes'] : undefined;
    if (!Array.isArray(schemes) || schemes.some((s) => typeof s !== 'string' || s === '')) {
      fail(where, 'ios.query_schemes must be a list of strings');
    }
    for (const side of ['android', 'harmony'] as const) {
      if (!isObj(def[side])) fail(where, `${side} must be an object`);
    }
    // Every external target is a shopping platform (platform is a contracts/enums platform):
    // ext.openApp never opens it without attribution (04 §9, BR-ATTR-29 细则).
    if (def['trade_only'] !== true) fail(where, 'trade_only must be true for a shopping platform');
    apps.push({ name, platform, status, trade_only: true, ios_query_schemes: schemes as string[] });
  }
  const sdkQueries = loadSdkQueries(appsDoc['sdk_queries']);
  const inbound = loadInbound(appsDoc['inbound'], apps, sdkQueries);
  const iosSchemes = [
    ...apps.flatMap((a) => a.ios_query_schemes),
    ...sdkQueries.flatMap((q) => (q.ios_scheme === null ? [] : [q.ios_scheme])),
  ];
  if (iosSchemes.length > MAX_IOS_QUERY_SCHEMES) {
    fail(
      'contracts/apps.json',
      `at most ${MAX_IOS_QUERY_SCHEMES} iOS query schemes in apps + sdk_queries (03 §4.5)`,
    );
  }

  // routes.json
  const routesDoc = readJson(routesFile, 'contracts/routes.json');
  if (!isObj(routesDoc['routes'])) fail('contracts/routes.json', 'routes must be an object');
  const authLevels = want('auth_level').filter((a) => a !== 'optional');
  const routeEntries = want('route_entry');
  const routes: RouteDef[] = [];
  for (const [name, def] of Object.entries(routesDoc['routes'])) {
    const where = `contracts/routes.json ${name}`;
    if (!ROUTE_NAME.test(name)) fail(where, 'route names are PascalCase');
    if (!isObj(def)) fail(where, 'must be an object');
    const kind = def['kind'];
    if (kind !== 'native' && kind !== 'h5') fail(where, 'kind: native | h5');
    const h5Path = def['h5_path'] ?? null;
    if (kind === 'h5' && (typeof h5Path !== 'string' || !h5Path.startsWith('/'))) {
      fail(where, 'h5 routes need an h5_path starting with "/"');
    }
    if (kind === 'native' && h5Path !== null) fail(where, 'native routes have no h5_path');
    const debugOnly = def['debug_only'] ?? false;
    if (typeof debugOnly !== 'boolean') fail(where, 'debug_only must be a boolean');
    const platformParam = at(def, 'params/properties/platform');
    if (
      platformParam !== undefined &&
      !sameSet(enumOf(`${where} platform`, platformParam), want('platform'))
    ) {
      fail(where, 'params.platform must list exactly the contracts/enums platform values');
    }
    const entry = def['entry'];
    if (
      !Array.isArray(entry) ||
      entry.length === 0 ||
      entry.some((e) => typeof e !== 'string' || !routeEntries.includes(e)) ||
      new Set(entry).size !== entry.length
    ) {
      fail(where, `entry must be a non-empty list of distinct ${routeEntries.join(' | ')}`);
    }
    const auth = def['auth'];
    if (typeof auth !== 'string' || !authLevels.includes(auth)) {
      fail(where, `auth must be one of ${authLevels.join(', ')}`);
    }
    routes.push({
      name,
      kind,
      h5_path: h5Path as string | null,
      auth,
      since: since(where, def['since']),
      phase: typeof def['phase'] === 'string' ? def['phase'] : fail(where, 'phase missing'),
      debug_only: debugOnly,
      entry: entry as string[],
      params: closedObjectSchema(`${where} params`, def['params']),
    });
  }
  // Funds and real-name pages take no external prefill (BR-WDR-01 细则): their params stay empty.
  for (const r of ['Withdraw', 'PayoutAccount', 'LaborAgreement', 'RealName']) {
    const def = routes.find((x) => x.name === r);
    if (def === undefined) fail('contracts/routes.json', `${r} is required (BR-WDR-01)`);
    const props = def.params['properties'];
    if (!isObj(props) || Object.keys(props).length > 0) {
      fail(
        `contracts/routes.json ${r}`,
        'params must be empty (no external prefill, BR-WDR-01 细则)',
      );
    }
  }
  for (const r of ['ExternalPage', 'WebPage']) {
    if (!routes.some((x) => x.name === r))
      fail('contracts/routes.json', `${r} is required (TECH-04)`);
  }

  // bridge.schema.json
  const bridge = readJson(bridgeFile, 'contracts/bridge.schema.json');
  const defs = isObj(bridge['$defs']) ? bridge['$defs'] : fail('bridge', '$defs missing');
  const check = (pointer: string, expected: readonly unknown[], what: string): void => {
    if (!sameSet(enumOf(`bridge $defs.${pointer}`, defs[pointer]), expected)) {
      fail(`contracts/bridge.schema.json $defs.${pointer}`, `must equal ${what}`);
    }
  };
  check('Platform', want('platform'), 'contracts/enums platform');
  check('UnionBindingStatus', want('union_binding_status'), 'contracts/enums union_binding_status');
  check(
    'AppTarget',
    apps.map((a) => a.name),
    'the keys of contracts/apps.json',
  );

  if (!isObj(bridge['methods'])) fail('bridge', 'methods must be an object');
  // Inline enums inside method schemas that mirror contracts/enums.
  const inline: Array<[string, string]> = [
    ['auth.getUser/result/properties/realname_status', 'realname_status'],
    ['ext.openApp/result/properties/installed', 'installed_state'],
    ['app.getEnv/result/properties/channel', 'install_channel'],
  ];
  for (const [pointer, enumName] of inline) {
    if (!sameSet(enumOf(`bridge ${pointer}`, at(bridge['methods'], pointer)), want(enumName))) {
      fail(`contracts/bridge.schema.json ${pointer}`, `must equal contracts/enums ${enumName}`);
    }
  }
  const methods: BridgeMethodDef[] = [];
  for (const [name, def] of Object.entries(bridge['methods'])) {
    const where = `contracts/bridge.schema.json ${name}`;
    const [ns, fn, extra] = name.split('.');
    if (extra !== undefined || ns === undefined || fn === undefined || !NAMESPACES.includes(ns)) {
      fail(where, `method names are <namespace>.<name>, namespace one of ${NAMESPACES.join(', ')}`);
    }
    if (!isObj(def)) fail(where, 'must be an object');
    const level = def['level'];
    const model = def['model'];
    const timeout = def['timeout_ms'];
    if (level !== 'L0' && level !== 'L1' && level !== 'L2') fail(where, 'level: L0 | L1 | L2');
    if (model !== 'sync' && model !== 'async') fail(where, 'model: sync | async');
    if (model === 'sync' && timeout !== null) fail(where, 'sync methods have timeout_ms null');
    if (
      timeout !== null &&
      (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)
    ) {
      fail(where, 'timeout_ms must be a positive integer or null (no timeout)');
    }
    methods.push({
      name,
      level,
      model,
      timeout_ms: timeout as number | null,
      phase: typeof def['phase'] === 'string' ? def['phase'] : fail(where, 'phase missing'),
      since: since(where, def['since']),
      params: closedObjectSchema(`${where} params`, def['params']),
      result: closedObjectSchema(`${where} result`, def['result']),
    });
  }

  const events: Array<{ name: string; data: Obj }> = [];
  if (!isObj(bridge['events'])) fail('bridge', 'events must be an object');
  for (const [name, data] of Object.entries(bridge['events'])) {
    events.push({ name, data: closedObjectSchema(`bridge event ${name}`, data) });
  }

  const errors = isObj(bridge['errors']) ? Object.keys(bridge['errors']).map(Number) : [];
  const range = ranges.find((r) => r.from === 90001 && r.to === 90500);
  if (range === undefined) fail('contracts/error-codes.yaml', 'range 90001–90500 missing');
  for (const code of errors) {
    if (!Number.isInteger(code) || code < range.from || code > range.to) {
      fail('contracts/bridge.schema.json errors', `${code} is outside ${range.from}–${range.to}`);
    }
  }

  // signed_paths: each entry, when the operation exists in openapi.yaml, must be x-signed.
  const openapi = parseYamlLite(readFileSync(openapiFile, 'utf8'));
  const paths = isObj(openapi) && isObj(openapi['paths']) ? openapi['paths'] : {};
  const signedPaths: Array<{ method: string; path: string }> = [];
  if (!Array.isArray(bridge['signed_paths'])) fail('bridge', 'signed_paths must be a list');
  for (const entry of bridge['signed_paths']) {
    if (!isObj(entry) || typeof entry['method'] !== 'string' || typeof entry['path'] !== 'string') {
      fail('bridge signed_paths', 'entries are {method, path}');
    }
    const method = entry['method'];
    const path = entry['path'];
    const item = paths[path];
    const op = isObj(item) ? item[method.toLowerCase()] : undefined;
    if (isObj(op) && op['x-signed'] !== true) {
      fail('bridge signed_paths', `${method} ${path} is not x-signed in openapi.yaml`);
    }
    signedPaths.push({ method, path });
  }
  return { bridge, methods, events, signedPaths, errors, routes, apps, sdkQueries, inbound };
}

function pascal(name: string): string {
  return name
    .split(/[._]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Rewrites `#/$defs/X` references to the synthetic document's `#/components/schemas/X`. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] =
      k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
        ? `#/components/schemas/${v.slice('#/$defs/'.length)}`
        : rewriteRefs(v);
  }
  return out;
}

export async function renderBridge(cat: BridgeCatalog): Promise<string> {
  const schemas: Obj = {};
  const defs = isObj(cat.bridge['$defs']) ? cat.bridge['$defs'] : {};
  for (const [k, v] of Object.entries(defs)) schemas[k] = rewriteRefs(v);
  for (const m of cat.methods) {
    schemas[`${pascal(m.name)}Params`] = rewriteRefs(m.params);
    schemas[`${pascal(m.name)}Result`] = rewriteRefs(m.result);
  }
  for (const e of cat.events) schemas[`${pascal(e.name)}Event`] = rewriteRefs(e.data);
  for (const r of cat.routes) schemas[`Route${r.name}Params`] = rewriteRefs(r.params);
  const doc = {
    openapi: '3.1.0',
    info: { title: 'bridge', version: '1' },
    paths: {},
    components: { schemas },
  };
  const ast = await openapiTS(JSON.parse(JSON.stringify(doc)), { silent: true });
  const out: string[] = [astToString(ast)];
  const s = (name: string): string => `components['schemas'][${JSON.stringify(name)}]`;

  out.push('/** JSBridge methods (规划/04 §9): params and result per method. */');
  out.push('export interface BridgeMethods {');
  for (const m of cat.methods) {
    // nav.open takes a route target; its per-route params come from routes.json.
    const params = m.name === 'nav.open' ? 'RouteTarget' : s(`${pascal(m.name)}Params`);
    out.push(
      `  ${JSON.stringify(m.name)}: { params: ${params}; result: ${s(`${pascal(m.name)}Result`)} };`,
    );
  }
  out.push('}');
  out.push('export type BridgeMethodName = keyof BridgeMethods;');
  out.push('');
  out.push('/** Level, call model, timeout and per-platform `since` of each method (03 §5.3). */');
  const meta = Object.fromEntries(
    cat.methods.map((m) => [
      m.name,
      { level: m.level, model: m.model, timeout_ms: m.timeout_ms, phase: m.phase, since: m.since },
    ]),
  );
  out.push(`export const bridgeMethods = ${JSON.stringify(meta, null, 2)} as const;`);
  out.push('');
  out.push('export interface BridgeEvents {');
  for (const e of cat.events)
    out.push(`  ${JSON.stringify(e.name)}: ${s(`${pascal(e.name)}Event`)};`);
  out.push('}');
  out.push('');
  out.push(
    '/** Method + path pairs net.signedRequest may sign (拍板第二批 TECH-30); others → 90403. */',
  );
  out.push(`export const signedPaths = ${JSON.stringify(cat.signedPaths)} as const;`);
  out.push(`export const bridgeErrorCodes = ${JSON.stringify(cat.errors)} as const;`);
  out.push('');
  out.push(
    '/** Route table (contracts/routes.json); jumps are {route, params} (拍板第二批 TECH-04). */',
  );
  const routeMeta = Object.fromEntries(
    cat.routes.map((r) => [
      r.name,
      {
        kind: r.kind,
        h5_path: r.h5_path,
        auth: r.auth,
        phase: r.phase,
        since: r.since,
        debug_only: r.debug_only,
        entry: r.entry,
      },
    ]),
  );
  out.push(`export const routes = ${JSON.stringify(routeMeta, null, 2)} as const;`);
  out.push('export type RouteName = keyof typeof routes;');
  out.push('/** Routes kept in release builds (debug_only routes are dropped there, TECH-11). */');
  out.push(
    `export const releaseRouteNames = ${JSON.stringify(cat.routes.filter((r) => !r.debug_only).map((r) => r.name))} as const;`,
  );
  out.push('export interface RouteParams {');
  for (const r of cat.routes) out.push(`  ${r.name}: ${s(`Route${r.name}Params`)};`);
  out.push('}');
  out.push(
    '/** A jump target shared by banners, push, messages, SDUI, Agent cards and nav.open. */',
  );
  // params may be omitted exactly when the route has no required params (as the JSON schema says).
  const optionalParams = cat.routes
    .filter((r) => Array.isArray(r.params['required']) && r.params['required'].length === 0)
    .map((r) => JSON.stringify(r.name));
  out.push(`export type RouteWithOptionalParams = ${optionalParams.join(' | ') || 'never'};`);
  out.push(
    'export type RouteTarget = { [N in RouteName]: N extends RouteWithOptionalParams ? { route: N; params?: RouteParams[N] } : { route: N; params: RouteParams[N] } }[RouteName];',
  );
  out.push('');
  out.push('/** External target apps (contracts/apps.json); the only targets of ext.openApp. */');
  const appMeta = Object.fromEntries(
    cat.apps.map((a) => [
      a.name,
      {
        platform: a.platform,
        status: a.status,
        trade_only: a.trade_only,
        ios_query_schemes: a.ios_query_schemes,
      },
    ]),
  );
  out.push(`export const apps = ${JSON.stringify(appMeta, null, 2)} as const;`);
  out.push('export type AppTarget = keyof typeof apps;');
  out.push(
    '/** SDK query entries and inbound callbacks (contracts/apps.json), input of the CT-05 generators. */',
  );
  out.push(`export const sdkQueries = ${JSON.stringify(cat.sdkQueries, null, 2)} as const;`);
  out.push(`export const inbound = ${JSON.stringify(cat.inbound, null, 2)} as const;`);
  out.push('');
  return out.join('\n');
}
