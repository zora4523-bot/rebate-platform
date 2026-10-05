// Reads contracts/enums/*.yaml and contracts/error-codes.yaml, checks their shape and renders the
// TypeScript catalogs src/enums.gen.ts and src/error-codes.gen.ts (CT-01).
// The YAML files are parsed with the repository's strict YAML subset parser (tools/lib/yaml-lite.ts):
// ADR-0001 lists no YAML library, and anything outside the subset is rejected instead of guessed.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import { enumsDir, errorCodesFile, repoRoot } from './paths.ts';

export type EnumDef = {
  name: string;
  file: string;
  source: string;
  description: string | null;
  values: Array<{ value: string; note: string }>;
};

export type ErrorCodeDef = {
  code: number;
  http: number;
  http_also: number[];
  meaning: string;
  action: string;
  retry: string;
  retry_kind: RetryKind;
  retry_kind_by_reason: Record<string, RetryKind>;
  data: Record<string, string[] | null>;
  headers: string[];
  sources: string[];
  phase: string | null;
  deprecated: boolean;
};

export type ErrorRangeDef = { from: number; to: number; meaning: string };

const RETRY_KINDS = ['never', 'after_action', 'later', 'immediate', 'not_applicable'] as const;
type RetryKind = (typeof RETRY_KINDS)[number];

const ENUM_NAME = /^[a-z][a-z0-9_]*$/;
// Enum codes are wire values: letters, digits and underscores (04 §5 snake_case / UPPER_CASE);
// dotted keys such as the admin permission points of 04 §11 (`user.list`) are allowed.
const ENUM_VALUE = /^[A-Za-z0-9][A-Za-z0-9_]*(\.[A-Za-z0-9][A-Za-z0-9_]*)*$/;
const DATA_FIELD = /^[a-z][a-z0-9_]*$/;
const HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429, 500, 503, 504]);
// Extra statuses a code may also use (`http_also`): request-body errors keep Fastify's 413 / 415.
const HTTP_ALSO_STATUSES = new Set([413, 415]);

class CatalogError extends Error {}

function fail(where: string, message: string): never {
  throw new CatalogError(`${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(where: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(where, `unknown field "${key}"`);
  }
}

function text(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail(where, 'must be a non-empty string');
  return value;
}

function stringList(where: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(where, 'must be a non-empty list');
  return value.map((item, i) => text(`${where}[${i}]`, item));
}

function httpAlsoList(where: string, value: unknown, http: number): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) fail(where, 'must be a non-empty list');
  let previous = 0;
  for (const status of value) {
    if (typeof status !== 'number' || !HTTP_ALSO_STATUSES.has(status)) {
      fail(where, `each status must be one of ${[...HTTP_ALSO_STATUSES].join(', ')}`);
    }
    if (status === http) fail(where, `must not repeat http ${http}`);
    if (status <= previous) fail(where, 'statuses must be ascending and unique');
    previous = status;
  }
  return value as number[];
}

function rel(file: string): string {
  return relative(repoRoot, file);
}

export function loadEnums(dir: string = enumsDir): EnumDef[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  if (files.length === 0) fail(rel(dir), 'no enum files');
  const seen = new Map<string, string>();
  const out: EnumDef[] = [];
  for (const f of files) {
    const file = join(dir, f);
    const doc = parseYamlLite(readFileSync(file, 'utf8'));
    if (!isRecord(doc)) fail(rel(file), 'must be a mapping');
    onlyKeys(rel(file), doc, ['enums']);
    const enums = doc['enums'];
    if (!isRecord(enums) || Object.keys(enums).length === 0) fail(rel(file), 'enums: empty');
    for (const [name, def] of Object.entries(enums)) {
      const where = `${rel(file)} ${name}`;
      if (!ENUM_NAME.test(name)) fail(where, 'enum name must be snake_case');
      const other = seen.get(name);
      if (other !== undefined) fail(where, `duplicate enum (also in ${other})`);
      seen.set(name, rel(file));
      if (!isRecord(def)) fail(where, 'must be a mapping');
      onlyKeys(where, def, ['source', 'description', 'values']);
      const values = def['values'];
      if (!isRecord(values) || Object.keys(values).length === 0) fail(where, 'values: empty');
      out.push({
        name,
        file: basename(file),
        source: text(`${where}.source`, def['source']),
        description:
          def['description'] === undefined
            ? null
            : text(`${where}.description`, def['description']),
        values: Object.entries(values).map(([value, note]) => {
          if (!ENUM_VALUE.test(value)) fail(`${where}.${value}`, 'invalid enum value');
          return { value, note: text(`${where}.${value}`, note) };
        }),
      });
    }
  }
  return out;
}

function errorData(where: string, value: unknown): Record<string, string[] | null> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length === 0) fail(where, 'must be a mapping');
  const out: Record<string, string[] | null> = {};
  for (const [field, allowed] of Object.entries(value)) {
    if (!DATA_FIELD.test(field)) fail(`${where}.${field}`, 'field name must be snake_case');
    out[field] = allowed === null ? null : stringList(`${where}.${field}`, allowed);
  }
  return out;
}

export function loadErrorCodes(file: string = errorCodesFile): {
  codes: ErrorCodeDef[];
  ranges: ErrorRangeDef[];
} {
  const where0 = rel(file);
  const doc = parseYamlLite(readFileSync(file, 'utf8'));
  if (!isRecord(doc)) fail(where0, 'must be a mapping');
  onlyKeys(where0, doc, ['version', 'codes', 'ranges']);
  if (doc['version'] !== 1) fail(where0, 'version must be 1');
  if (!Array.isArray(doc['codes']) || doc['codes'].length === 0) fail(where0, 'codes: empty');
  const codes: ErrorCodeDef[] = [];
  let previous = 0;
  for (const [i, entry] of doc['codes'].entries()) {
    const where = `${where0} codes[${i}]`;
    if (!isRecord(entry)) fail(where, 'must be a mapping');
    onlyKeys(where, entry, [
      'code',
      'http',
      'http_also',
      'meaning',
      'action',
      'retry',
      'retry_kind',
      'retry_kind_by_reason',
      'data',
      'headers',
      'sources',
      'phase',
      'deprecated',
    ]);
    const code = entry['code'];
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 10000 || code > 59999) {
      fail(where, 'code must be a 5-digit integer in 10000–59999');
    }
    if (code <= previous) fail(where, `code ${code} is not in ascending order (unique)`);
    previous = code;
    const http = entry['http'];
    if (typeof http !== 'number' || !HTTP_STATUSES.has(http)) {
      fail(where, `http must be one of ${[...HTTP_STATUSES].join(', ')}`);
    }
    const httpAlso = httpAlsoList(`${where}.http_also`, entry['http_also'], http);
    const retryKind = entry['retry_kind'];
    if (!(RETRY_KINDS as readonly unknown[]).includes(retryKind)) {
      fail(where, `retry_kind must be one of ${RETRY_KINDS.join(', ')}`);
    }
    const data = errorData(`${where}.data`, entry['data']);
    const byReason: Record<string, RetryKind> = {};
    const rawByReason = entry['retry_kind_by_reason'];
    if (rawByReason !== undefined) {
      if (!isRecord(rawByReason) || Object.keys(rawByReason).length === 0) {
        fail(where, 'retry_kind_by_reason must be a non-empty mapping');
      }
      const reasons = data['reason'];
      for (const [reason, kind] of Object.entries(rawByReason)) {
        if (!Array.isArray(reasons) || !reasons.includes(reason)) {
          fail(where, `retry_kind_by_reason: "${reason}" is not a listed data.reason value`);
        }
        if (!(RETRY_KINDS as readonly unknown[]).includes(kind)) {
          fail(where, `retry_kind_by_reason.${reason} must be one of ${RETRY_KINDS.join(', ')}`);
        }
        byReason[reason] = kind as RetryKind;
      }
    }
    const phase = entry['phase'];
    if (phase !== undefined && phase !== 'P1') fail(where, 'phase must be P1 when present');
    const deprecated = entry['deprecated'];
    if (deprecated !== undefined && deprecated !== true) fail(where, 'deprecated must be true');
    codes.push({
      code,
      http,
      http_also: httpAlso,
      meaning: text(`${where}.meaning`, entry['meaning']),
      action: text(`${where}.action`, entry['action']),
      retry: text(`${where}.retry`, entry['retry']),
      retry_kind: retryKind as RetryKind,
      retry_kind_by_reason: byReason,
      data,
      headers:
        entry['headers'] === undefined ? [] : stringList(`${where}.headers`, entry['headers']),
      sources: stringList(`${where}.sources`, entry['sources']),
      phase: phase ?? null,
      deprecated: deprecated === true,
    });
  }
  const ranges: ErrorRangeDef[] = [];
  const rawRanges = doc['ranges'] ?? [];
  if (!Array.isArray(rawRanges)) fail(where0, 'ranges must be a list');
  for (const [i, entry] of rawRanges.entries()) {
    const where = `${where0} ranges[${i}]`;
    if (!isRecord(entry)) fail(where, 'must be a mapping');
    onlyKeys(where, entry, ['from', 'to', 'meaning', 'action', 'sources']);
    const from = entry['from'];
    const to = entry['to'];
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      !(from < to)
    ) {
      fail(where, 'from / to must be integers with from < to');
    }
    if (codes.some((c) => c.code >= from && c.code <= to)) fail(where, 'overlaps a code');
    text(`${where}.action`, entry['action']);
    stringList(`${where}.sources`, entry['sources']);
    ranges.push({ from, to, meaning: text(`${where}.meaning`, entry['meaning']) });
  }
  return { codes, ranges };
}

function pascal(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function comment(lines: string[], indent = ''): string {
  return [
    `${indent}/**`,
    ...lines.map((l) => `${indent} * ${l.replaceAll('*/', '*\\/')}`),
    `${indent} */`,
  ].join('\n');
}

export function renderEnums(defs: readonly EnumDef[]): string {
  const out: string[] = [];
  for (const def of defs) {
    const lines = [
      def.description ?? def.name,
      `Source: ${def.source} (contracts/enums/${def.file}).`,
    ];
    out.push(comment(lines));
    out.push(`export const ${def.name} = [`);
    for (const v of def.values)
      out.push(`  ${JSON.stringify(v.value)}, // ${v.note.replaceAll('\n', ' ')}`);
    out.push('] as const;');
    out.push(`export type ${pascal(def.name)} = (typeof ${def.name})[number];`);
    out.push('');
  }
  out.push('/** Every enum of contracts/enums, by name. */');
  out.push('export const enums = {');
  for (const def of defs) out.push(`  ${def.name},`);
  out.push('} as const;');
  out.push('export type EnumName = keyof typeof enums;');
  out.push('export type EnumValue<Name extends EnumName> = (typeof enums)[Name][number];');
  out.push('');
  return out.join('\n');
}

export function renderErrorCodes(
  codes: readonly ErrorCodeDef[],
  ranges: readonly ErrorRangeDef[],
): string {
  const out: string[] = [];
  out.push(
    comment([
      'Error code catalog (规划/08 §13.11 is the single allocation table; data shapes from 规划/04 §7).',
      'Clients act on `code`; texts come from the dictionary key error.<code> (BR-TEXT-14).',
    ]),
  );
  out.push('export const errorCodes = {');
  for (const c of codes) {
    out.push(`  ${c.code}: {`);
    out.push(`    http: ${c.http},`);
    out.push(`    http_also: ${JSON.stringify(c.http_also)},`);
    out.push(`    meaning: ${JSON.stringify(c.meaning)},`);
    out.push(`    action: ${JSON.stringify(c.action)},`);
    out.push(`    retry: ${JSON.stringify(c.retry)},`);
    out.push(`    retry_kind: ${JSON.stringify(c.retry_kind)},`);
    out.push(`    retry_kind_by_reason: ${JSON.stringify(c.retry_kind_by_reason)},`);
    out.push(`    data: ${JSON.stringify(c.data)},`);
    out.push(`    headers: ${JSON.stringify(c.headers)},`);
    out.push(`    sources: ${JSON.stringify(c.sources)},`);
    out.push(`    phase: ${JSON.stringify(c.phase)},`);
    out.push(`    deprecated: ${c.deprecated},`);
    out.push('  },');
  }
  out.push('} as const;');
  out.push('export type ErrorCode = keyof typeof errorCodes;');
  out.push('export type ErrorRetryKind = (typeof errorCodes)[ErrorCode]["retry_kind"];');
  out.push('');
  out.push('/** Code ranges reserved as a whole (e.g. the JSBridge-only 90001–90500). */');
  out.push(`export const errorCodeRanges = ${JSON.stringify(ranges)} as const;`);
  out.push('');
  return out.join('\n');
}
