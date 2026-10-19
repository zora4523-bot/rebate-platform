import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  MAX_CONFIG_PASSES,
  consistentConfigValues,
  type LaborAgreementConfigReader,
} from './labor-agreement.ts';

type Row = { value: unknown; version: number };
const KEYS = [
  'legal.labor_agreement.version',
  'legal.labor_agreement.text_url',
  'legal.labor_agreement.text_sha256',
  'legal.labor_agreement.resign_from_version',
] as const;
const V1: Record<string, Row> = {
  'legal.labor_agreement.version': { value: 1, version: 1 },
  'legal.labor_agreement.text_url': { value: 'https://example.test/a.html', version: 1 },
  'legal.labor_agreement.text_sha256': { value: 'a'.repeat(64), version: 1 },
  'legal.labor_agreement.resign_from_version': { value: 1, version: 1 },
};
/** One publication: version, URL and digest change in one transaction, the threshold stays. */
const V2: Record<string, Row> = {
  ...V1,
  'legal.labor_agreement.version': { value: 2, version: 2 },
  'legal.labor_agreement.text_url': { value: 'https://example.test/b.html', version: 2 },
  'legal.labor_agreement.text_sha256': { value: 'b'.repeat(64), version: 2 },
};
const HANDLE = {} as Kysely<DB>;

/** A reader over a table whose committed state is replaced by `commits[i]` after read number i. */
function readerWithCommits(
  initial: Record<string, Row>,
  commits: Map<number, Record<string, Row>>,
) {
  let table = initial;
  let reads = 0;
  const reader: LaborAgreementConfigReader = {
    configValue(_appId, key, handle) {
      expect(handle).toBe(HANDLE);
      const row = table[key] ?? null;
      reads += 1;
      table = commits.get(reads) ?? table;
      return Promise.resolve(row === null ? null : { ...row });
    },
  };
  return { reader, reads: () => reads };
}

const valuesOf = (rows: Record<string, Row>) =>
  new Map(KEYS.filter((key) => rows[key] !== undefined).map((key) => [key, rows[key]!.value]));

it('[AC-B1-13h] config read: an unchanged table is read in two passes', async () => {
  const { reader, reads } = readerWithCommits(V1, new Map());
  expect(await consistentConfigValues(reader, HANDLE, 'app', KEYS)).toEqual({
    ok: true,
    values: valuesOf(V1),
  });
  expect(reads()).toBe(KEYS.length * 2);
});

it('[AC-B1-13h] config read: a publication committed half-way never yields the old version with the new URL and digest', async () => {
  // v2 commits right after the version key was read (old) and before the URL / digest (new).
  const { reader } = readerWithCommits(V1, new Map([[1, V2]]));
  const result = await consistentConfigValues(reader, HANDLE, 'app', KEYS);
  expect(result).toEqual({ ok: true, values: valuesOf(V2) });
  // The same half-way commit during the second pass is caught as well.
  const late = readerWithCommits(V1, new Map([[KEYS.length + 1, V2]]));
  expect(await consistentConfigValues(late.reader, HANDLE, 'app', KEYS)).toEqual({
    ok: true,
    values: valuesOf(V2),
  });
});

it('[AC-B1-13h] config read: a value changed and changed back is caught by config_items.version', async () => {
  const back = {
    ...V1,
    'legal.labor_agreement.text_sha256': { value: 'a'.repeat(64), version: 3 },
  };
  const { reader, reads } = readerWithCommits(V1, new Map([[KEYS.length + 1, back]]));
  expect(await consistentConfigValues(reader, HANDLE, 'app', KEYS)).toEqual({
    ok: true,
    values: valuesOf(back),
  });
  expect(reads()).toBe(KEYS.length * 3);
});

it('[AC-B1-13h] config read: a key added or removed between passes is a change; absent keys stay absent', async () => {
  const without = { ...V1 };
  delete (without as Record<string, Row | undefined>)['legal.labor_agreement.text_url'];
  const { reader } = readerWithCommits(without, new Map([[KEYS.length, V1]]));
  expect(await consistentConfigValues(reader, HANDLE, 'app', KEYS)).toEqual({
    ok: true,
    values: valuesOf(V1),
  });
  const stable = readerWithCommits(without, new Map());
  const result = await consistentConfigValues(stable.reader, HANDLE, 'app', KEYS);
  expect(result.ok && result.values.has('legal.labor_agreement.text_url')).toBe(false);
});

it('[AC-B1-13h] config read: a configuration that keeps changing is given up, never returned mixed', async () => {
  const commits = new Map<number, Record<string, Row>>();
  for (let read = 1; read <= KEYS.length * MAX_CONFIG_PASSES; read += 1) {
    commits.set(
      read,
      read % 2 === 0 ? { ...V1, 'legal.labor_agreement.version': { value: 1, version: read } } : V2,
    );
  }
  const { reader, reads } = readerWithCommits(V1, commits);
  expect(await consistentConfigValues(reader, HANDLE, 'app', KEYS)).toEqual({ ok: false });
  expect(reads()).toBe(KEYS.length * MAX_CONFIG_PASSES);
});
