// specs/app-stores.yaml (03 §4.1, CT-19b): text-level assertions; the structure check is
// scripts/app-stores.ts in `pnpm contracts:check`.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { install_channel } from './index.ts';

const raw = readFileSync(new URL('../../../specs/app-stores.yaml', import.meta.url), 'utf8');
const body = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

it('lists one store for each single-store channel and no official-package store yet', () => {
  const channels = [...body.matchAll(/^ {4}channels: \[([^\]]*)\]$/gm)].flatMap((m) =>
    (m[1] ?? '').split(',').map((c) => c.trim()),
  );
  expect(channels.sort()).toEqual(['agc', 'appstore', 'huawei']);
  for (const c of channels) expect(install_channel).toContain(c);
});

it('carries no listed version and no value that 08 / 03 do not give', () => {
  expect(raw).not.toMatch(/listed_version/);
  expect([...body.matchAll(/^ {2}- key: (.*)$/gm)].map((m) => m[1])).toEqual([
    'null',
    'null',
    'null',
  ]);
  expect(body).not.toMatch(/install_source_packages: \[[^\]]/);
  expect(
    [...body.matchAll(/^ {6}(open_method|target): (.*)$/gm)].every((m) => m[2] === 'null'),
  ).toBe(true);
});
