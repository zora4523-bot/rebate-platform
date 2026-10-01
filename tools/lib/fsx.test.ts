import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeFileAtomic } from './fsx.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'couli-fsx-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates parent directories and writes the content', () => {
    const file = join(dir, 'state', 'B2-03a.json');
    writeFileAtomic(file, '{"state":"ready"}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"state":"ready"}\n');
  });

  it('replaces an existing file and leaves no temporary file behind', () => {
    const file = join(dir, 'usage.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two 中文');
    expect(readFileSync(file, 'utf8')).toBe('two 中文');
    expect(readdirSync(dir)).toEqual(['usage.json']);
  });

  it('cleans up and throws when the target cannot be replaced', () => {
    const target = join(dir, 'occupied');
    writeFileAtomic(join(target, 'child'), 'x');
    expect(() => writeFileAtomic(target, 'y')).toThrow();
    expect(readdirSync(dir)).toEqual(['occupied']);
  });
});

describe('readJsonFile', () => {
  it('parses JSON', () => {
    const file = join(dir, 'a.json');
    writeFileSync(file, '{"a":[1,2,{"b":null}]}');
    expect(readJsonFile(file)).toEqual({ a: [1, 2, { b: null }] });
  });

  it('names the file when it is missing or invalid', () => {
    const missing = join(dir, 'missing.json');
    expect(() => readJsonFile(missing)).toThrow(/cannot read .*missing\.json/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{nope');
    expect(() => readJsonFile(bad)).toThrow(/invalid JSON in .*bad\.json/);
  });
});
