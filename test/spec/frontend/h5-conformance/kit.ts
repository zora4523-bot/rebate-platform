import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import { BridgeContract } from '@couli/bridge-sdk';
import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  BridgeTransport,
} from '@couli/bridge-sdk';
import type {
  ConformanceCase,
  ConformanceResult,
} from '../../../../apps/h5/src/entries/conformance/model.ts';

export const contract = BridgeContract;
const moduleUrl = import.meta.url;
const root = new URL('../../../../', moduleUrl);

interface Schema {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  oneOf?: Schema[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export const rawContract = JSON.parse(
  readFileSync(new URL('contracts/bridge.schema.json', root), 'utf8'),
) as { methods: Record<string, { params: Schema }>; $defs: Record<string, Schema> };

// The only concrete link_patterns values at SPEC_REF are in the OpenAPI config example.
// Read its union_host block, rather than inventing real shopping-platform domains.
const openapi = readFileSync(new URL('contracts/openapi.yaml', root), 'utf8');
const linkPatternExample =
  /                  link_patterns:\n([\s\S]*?)                  external_hosts:/m.exec(
    openapi,
  )?.[1] ?? '';
export const linkPatternHosts = [
  ...linkPatternExample.matchAll(/^\s+- ([a-z][a-z0-9.-]+\.[a-z]+)\s*$/gm),
].map((match) => match[1]!);
const shareDomainExample =
  /                  share_domains:\n([\s\S]*?)                  features:/m.exec(openapi)?.[1] ??
  '';
export const shareExampleHosts = [
  ...shareDomainExample.matchAll(/^\s+- ([a-z][a-z0-9.-]+\.[a-z]+)\s*$/gm),
].map((match) => match[1]!);
export const blockedLinkVariants = linkPatternHosts.flatMap((host) => [
  { variant: 'base', url: `https://${host}/` },
  { variant: 'host_case', url: `https://${host.toUpperCase()}/` },
  { variant: 'trailing_dot', url: `https://${host}./` },
  { variant: 'default_port', url: `https://${host}:443/` },
  { variant: 'percent_host', url: `https://%${host.charCodeAt(0).toString(16)}${host.slice(1)}/` },
  { variant: 'percent_path', url: `https://${host}/%70roduct` },
]);

export function caseUrl(testCase: ConformanceCase, params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined;
  const object = params as { url?: string; content?: { url?: string } };
  return testCase.method === 'share.open' ? object.content?.url : object.url;
}

// A test-only oracle for the JSON Schema vocabulary used by bridge params at SPEC_REF.
// It checks candidates supplied by the page; it does not generate those candidates.
export function validParams(schema: Schema, value: unknown): boolean {
  if (schema.$ref) {
    const referenced = rawContract.$defs[schema.$ref.replace('#/$defs/', '')];
    expect(referenced, `resolved schema ${schema.$ref}`).toBeDefined();
    return validParams(referenced!, value);
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter((branch) => validParams(branch, value)).length !== 1) {
    return false;
  }
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(object).some((key) => !(key in properties))
    ) {
      return false;
    }
    return Object.entries(properties).every(
      ([key, child]) => !Object.hasOwn(object, key) || validParams(child, object[key]),
    );
  }
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      value.length >= (schema.minItems ?? 0) &&
      value.length <= (schema.maxItems ?? Infinity) &&
      value.every((item) => !schema.items || validParams(schema.items, item))
    );
  }
  if (schema.type === 'string') {
    return (
      typeof value === 'string' &&
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Infinity) &&
      (!schema.pattern || new RegExp(schema.pattern).test(value))
    );
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      typeof value === 'number' &&
      (schema.type !== 'integer' || Number.isInteger(value)) &&
      value >= (schema.minimum ?? -Infinity) &&
      value <= (schema.maximum ?? Infinity)
    );
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

export const mvp = Object.entries(contract.bridgeMethods).filter(([, meta]) =>
  Object.values(meta.since).every((version) => version !== null),
);
export const deferred = Object.entries(contract.bridgeMethods).filter(([, meta]) =>
  Object.values(meta.since).some((version) => version === null),
);

// Safety oracle, not a duplicate method catalogue: matching normals must require a tap.
export function requiresTap(method: string): boolean {
  return /^(nav\.(close|open)|trade\..+|ext\..+|share\.open|cs\.open|auth\.login|perm\.request|media\.saveImage|net\.signedRequest|clipboard\.write)$/.test(
    method,
  );
}

export function installBridge(
  respond: (request: BridgeRequest) => BridgeResponse | Promise<BridgeResponse> = (request) => ({
    id: request.id,
    code: 0,
    msg: '',
    data: {},
  }),
) {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const postMessage = vi.fn(respond);
  const transport: BridgeTransport = {
    version: 1,
    methods: mvp.map(([method]) => method),
    postMessage,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return {
    postMessage,
    emit(event: BridgeEvent) {
      for (const listener of listeners) listener(event);
    },
    listeners,
  };
}

export function result(): ConformanceResult {
  const value = (window as unknown as { __RESULT__?: ConformanceResult }).__RESULT__;
  expect(value, 'page publishes window.__RESULT__').toBeDefined();
  return value!;
}

export function assertResultSchema(value: ConformanceResult): void {
  expect(Object.keys(value).sort()).toEqual([
    'bridge_present',
    'cases',
    'events',
    'schema',
    'status',
    'summary',
    'unknown_cases',
  ]);
  expect(value.schema).toBe('couli.bridge-conformance/1');
  expect(['running', 'done']).toContain(value.status);
  expect(typeof value.bridge_present).toBe('boolean');
  expect(Object.keys(value.events).sort()).toEqual(['app.pause', 'app.resume']);
  expect(Array.isArray(value.events['app.pause'])).toBe(true);
  expect(Array.isArray(value.events['app.resume'])).toBe(true);
  expect(value.unknown_cases.every((id) => typeof id === 'string')).toBe(true);
  for (const row of value.cases) {
    expect(Object.keys(row).sort()).toEqual([
      'category',
      'expect',
      'id',
      'method',
      'ms',
      'outcome',
      'pass',
      'trigger',
    ]);
    expect(typeof row.id).toBe('string');
    expect(typeof row.method).toBe('string');
    expect(['normal', 'timeout', 'unsupported', 'bad_params', 'no_gesture', 'negative']).toContain(
      row.category,
    );
    expect(['auto', 'tap', 'harness']).toContain(row.trigger);
    if ('code' in row.expect) {
      expect(Object.keys(row.expect)).toEqual(['code']);
      expect(contract.bridgeErrorCodes).toContain(row.expect.code);
    } else {
      expect(Object.keys(row.expect)).toEqual(['ok']);
      expect(typeof row.expect.ok).toBe('boolean');
      if (!row.expect.ok) expect(row.id).toBe('frame/negative/subframe');
    }
    if (row.outcome === null) {
      expect(row.pass).toBeNull();
      expect(row.ms).toBeNull();
    } else {
      expect(typeof row.ms).toBe('number');
      expect(Number.isFinite(row.ms)).toBe(true);
      expect(row.ms).toBeGreaterThanOrEqual(0);
      if (row.outcome.ok) expect(row.outcome).toEqual({ ok: true });
      else {
        expect(Object.keys(row.outcome).sort()).toEqual(['code', 'ok']);
        expect(contract.bridgeErrorCodes).toContain(row.outcome.code);
      }
      const pass =
        'code' in row.expect
          ? !row.outcome.ok && row.outcome.code === row.expect.code
          : row.outcome.ok === row.expect.ok;
      expect(row.pass).toBe(pass);
    }
  }
  expect(value.summary).toEqual({
    total: value.cases.length,
    passed: value.cases.filter((row) => row.pass === true).length,
    failed: value.cases.filter((row) => row.pass === false).length,
    pending: value.cases.filter((row) => row.pass === null).length,
  });
}

export const sampleCases: ConformanceCase[] = [
  {
    id: 'app.getEnv/normal',
    method: 'app.getEnv',
    category: 'normal',
    trigger: 'auto',
    expect: { ok: true },
  },
  {
    id: 'nav.close/normal',
    method: 'nav.close',
    category: 'normal',
    trigger: 'tap',
    expect: { ok: true },
  },
  {
    id: 'auth.getUser/timeout',
    method: 'auth.getUser',
    category: 'timeout',
    trigger: 'harness',
    expect: { code: 90003 },
  },
  {
    id: 'frame/negative/subframe',
    method: 'app.getEnv',
    category: 'negative',
    trigger: 'auto',
    expect: { ok: false },
  },
];
