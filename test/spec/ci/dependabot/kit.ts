import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// CT-23 has no acceptance ids; the CT-23#n identifiers are local to this task (规划/05 CT-23,
// ADR-0001 §2). Static reads only: no network, no GitHub API, no Dependabot run.
export const CONFIG = '.github/dependabot.yml';
// ADR-0001 §2: new versions are installed only after 7 days (pnpm minimumReleaseAge 10080).
export const RELEASE_AGE_DAYS = 7;
export const MINUTES_PER_DAY = 24 * 60;
export const MAX_OPEN_PULL_REQUESTS = 10;
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export function rootUrl(path: string): URL {
  return new URL(`../../../../${path}`, import.meta.url);
}

export function asset(path: string): string {
  const url = rootUrl(path);
  // A missing deliverable must be an AssertionError, not ENOENT, on the skeleton.
  expect(existsSync(url), `任务要求交付 ${path}`).toBe(true);
  const text = readFileSync(url, 'utf8');
  expect(text.trim(), `${path} 不能为空`).not.toBe('');
  return text;
}

export function yaml(path: string): unknown {
  const text = asset(path);
  let parsed: unknown;
  expect(() => {
    parsed = parseYamlLite(text);
  }, `${path} 须能被仓库的 YAML 子集解析`).not.toThrow();
  return parsed;
}

export function record(value: unknown, what = 'value'): Record<string, unknown> {
  expect(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${what} 应为映射`,
  ).toBe(true);
  return value as Record<string, unknown>;
}

export function list(value: unknown, what = 'value'): unknown[] {
  expect(Array.isArray(value), `${what} 应为序列`).toBe(true);
  return value as unknown[];
}

export function dependabot(): Record<string, unknown> {
  return record(yaml(CONFIG), CONFIG);
}

/** The single `updates` entry (2c: exactly one, npm). */
export function npmUpdate(): Record<string, unknown> {
  const updates = list(dependabot()['updates'], 'updates');
  expect(updates, 'updates 恰有一项').toHaveLength(1);
  return record(updates[0], 'updates[0]');
}

/** Every mapping key anywhere in the parsed document, with its dotted path. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => keyPaths(item, `${prefix}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(item, path)];
  });
}
