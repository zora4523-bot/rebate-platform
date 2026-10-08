import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// B1-01zc §9 is the acceptance source; AC-B1-01zc identifiers are local to this task.
// Read deployment assets only. Never read node env files or execute shell/Docker commands.
export const ENTRIES = ['api', 'stream', 'worker', 'admin', 'payout'] as const;
export const HTTP_ENTRIES = ['api', 'stream', 'admin'] as const;

export function asset(path: string): string {
  const url = new URL(`../../../../${path}`, import.meta.url);
  // Missing non-TS assets must produce AssertionError, not ENOENT or import errors on red.
  expect(existsSync(url), `${path} must exist`).toBe(true);
  const text = readFileSync(url, 'utf8');
  expect(text.trim(), `${path} must not be empty`).not.toBe('');
  return text;
}

export function record(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

export function string(value: unknown): string {
  expect(typeof value).toBe('string');
  return value as string;
}

export function services(): Record<string, unknown> {
  const text = asset('infra/staging/compose.yaml');
  const root = composeDocument(text);
  expect(root['include']).toBeUndefined();
  return record(root['services']);
}

// Text-level anchor expansion before the repository's YAML-subset parser. Support block
// mapping/sequence and scalar anchors, aliases, and << merges (including alias lists).
// Record paths instead of copying text so explicit service keys override merged defaults.
function composeDocument(text: string): Record<string, unknown> {
  const anchors = new Map<string, string[]>();
  const parents: { indent: number; key: string }[] = [];
  const marker = '__B1_01zc_alias_';
  expect(text).not.toContain(marker);
  const normalized = text
    .split(/\r?\n/)
    .map((line) => {
      const mapping = /^( *)([\w<>-]+):(?:\s+(.*))?$/.exec(line);
      if (!mapping) {
        // Alias items also occur in block merge lists and shared env_file lists.
        return line.replace(/^(\s*-\s+)\*([\w-]+)(\s*(?:#.*)?)$/, `$1${marker}$2$3`);
      }
      const indent = (mapping[1] ?? '').length;
      while (parents.length && (parents.at(-1)?.indent ?? -1) >= indent) parents.pop();
      const key = mapping[2] ?? '';
      let value = mapping[3] ?? '';
      const anchor = /^&([\w-]+)(?:\s+(.*))?$/.exec(value);
      if (anchor) {
        const name = anchor[1] ?? '';
        expect(anchors.has(name), 'anchor names must be unique').toBe(false);
        anchors.set(name, [...parents.map((parent) => parent.key), key]);
        value = anchor[2] ?? '';
      }
      if (/^\*[\w-]+(?:\s+#.*)?$/.test(value)) value = value.replace('*', marker);
      if (/^\[\s*\*[\w-]+(?:\s*,\s*\*[\w-]+)*\s*\]$/.test(value)) {
        value = value.replace(/\*/g, marker);
      }
      parents.push({ indent, key });
      return `${' '.repeat(indent)}${key}: ${value}`;
    })
    .join('\n');
  let parsed: unknown;
  expect(() => {
    parsed = parseYamlLite(normalized);
  }, 'parse compose after anchor expansion').not.toThrow();
  const raw = record(parsed);
  const resolve = (value: unknown, active: string[] = []): unknown => {
    if (typeof value === 'string' && value.startsWith(marker)) {
      const name = value.slice(marker.length);
      expect(active, 'recursive YAML aliases are unsupported').not.toContain(name);
      expect(anchors.has(name), `unknown YAML alias ${name}`).toBe(true);
      let target: unknown = raw;
      for (const key of anchors.get(name) ?? []) target = record(target)[key];
      return resolve(target, [...active, name]);
    }
    if (Array.isArray(value)) return value.map((item) => resolve(item, active));
    if (value === null || typeof value !== 'object') return value;
    const input = record(value);
    const output: Record<string, unknown> = {};
    if (input['<<'] !== undefined) {
      const merged = resolve(input['<<'], active);
      const sources = Array.isArray(merged) ? merged : [merged];
      for (const source of [...sources].reverse()) Object.assign(output, record(source));
    }
    for (const [key, item] of Object.entries(input)) {
      if (key !== '<<') output[key] = resolve(item, active);
    }
    return output;
  };
  return record(resolve(raw));
}

export function environment(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) return record(value);
  const entries = value.map((item) => {
    const text = string(item);
    const split = text.indexOf('=');
    return split < 0 ? [text, null] : [text.slice(0, split), text.slice(split + 1)];
  });
  return Object.fromEntries(entries);
}

export function envFiles(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    const entry = record(item);
    expect(entry['required']).not.toBe(false);
    return string(entry['path']);
  });
}

export function command(value: unknown): string {
  return Array.isArray(value) ? value.map(string).join(' ') : string(value);
}

// Drop shell/Docker comments without stripping # inside quoted probes or ${1:?…}.
// Backslash continuations are joined before checking command order.
export function sourceLines(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      let quote = '';
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '\\' && quote !== "'") {
          i++;
          continue;
        }
        if (quote !== '') {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
          return line.slice(0, i).trim();
        }
      }
      return line.trim();
    })
    .filter((line) => line !== '');
}

export function noInlineCredentials(text: string): void {
  expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^\s/'"]*:[^\s@'"/]+@/i);
  expect(text).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  expect(text).not.toMatch(
    /\b(?:DATABASE(?:_READ|_MAINT)?_URL|MIGRATOR_DATABASE_URL|REDIS_URL|[A-Z_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY))\s*[:=]\s*\S/i,
  );
}

export function imageVariable(): string {
  const image = string(record(services()['api'])['image']);
  const variables = [
    ...image.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::\?[^}]*)?\}|\$([A-Z_][A-Z0-9_]*)/g),
  ];
  expect(variables, 'one caller-supplied image/tag variable, without a default tag').toHaveLength(
    1,
  );
  const match = variables[0];
  return string(match?.[1] ?? match?.[2]);
}
