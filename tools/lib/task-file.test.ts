import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTaskIds, loadTask, parseTaskFile } from './task-file.ts';

const EXAMPLE = [
  'id: B2-02a',
  'repo: rebate-platform',
  'title: ledger：凭证与分录写入、余额缓存、账户行锁',
  'type: impl',
  'refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]',
  'refs_hash:',
  '  BR-FUND-13: 0123456789ab',
  '  BR-FUND-16: 123456789abc',
  '  BR-FUND-19: 23456789abcd',
  'deps: [B2-01]',
  'paths:',
  '  - "apps/api/src/modules/ledger/**"',
  'impl: codex',
  'tester: claude',
  'accept:',
  '  - "pnpm verify"',
  '  - "test/spec/ledger/**"',
  'status: todo',
  'pr: null',
  '',
].join('\n');

function messageOf(text: string, fileName: string): string {
  try {
    parseTaskFile(text, fileName);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('parseTaskFile', () => {
  it('parses the example of the planning template', () => {
    expect(parseTaskFile(EXAMPLE, 'ops/tasks/B2-02a.yaml')).toEqual({
      id: 'B2-02a',
      repo: 'rebate-platform',
      title: 'ledger：凭证与分录写入、余额缓存、账户行锁',
      type: 'impl',
      refs: ['BR-FUND-13', 'BR-FUND-16', 'BR-FUND-19'],
      refs_hash: {
        'BR-FUND-13': '0123456789ab',
        'BR-FUND-16': '123456789abc',
        'BR-FUND-19': '23456789abcd',
      },
      deps: ['B2-01'],
      paths: ['apps/api/src/modules/ledger/**'],
      impl: 'codex',
      tester: 'claude',
      accept: ['pnpm verify', 'test/spec/ledger/**'],
      status: 'todo',
      pr: null,
    });
  });

  it('defaults a missing pr to null and accepts a PR number', () => {
    const withoutPr = EXAMPLE.replace('pr: null\n', '');
    expect(parseTaskFile(withoutPr, 'B2-02a.yaml').pr).toBeNull();
    const done = EXAMPLE.replace('status: todo', 'status: done').replace('pr: null', 'pr: 37');
    expect(parseTaskFile(done, 'B2-02a.yaml')).toMatchObject({ status: 'done', pr: 37 });
  });

  it('accepts empty refs, deps and refs_hash', () => {
    const text = EXAMPLE.replace('refs: [BR-FUND-13, BR-FUND-16, BR-FUND-19]', 'refs: []')
      .replace(/refs_hash:\n(?: {2}BR-.*\n){3}/, 'refs_hash: {}\n')
      .replace('deps: [B2-01]', 'deps: []');
    expect(parseTaskFile(text, 'B2-02a.yaml')).toMatchObject({ refs: [], refs_hash: {}, deps: [] });
  });

  it('lists every problem in one error', () => {
    const text = [
      'id: b2',
      'repo: web',
      'title: ""',
      'type: feature',
      'refs: BR-FUND-13',
      'refs_hash: [x]',
      'deps: [nope]',
      'paths: []',
      'impl: gpt',
      'tester: nobody',
      'accept: []',
      'status: doing',
      'pr: -1',
      'risk: RV0',
    ].join('\n');
    const message = messageOf(text, 'b2.yaml');
    for (const field of [
      'risk: unknown field',
      'id: must look like',
      'repo: must be one of',
      'title: must be a single non-empty line',
      'type: must be one of',
      'refs: must be a list of strings',
      'refs_hash: must be a mapping',
      'deps: "nope" is not a task id',
      'paths: must not be empty',
      'impl: must be one of',
      'tester: must be one of',
      'accept: must not be empty',
      'status: must be one of',
      'pr: must be a positive integer or null',
    ]) {
      expect(message).toContain(field);
    }
  });

  it('reports missing fields', () => {
    const message = messageOf('id: B2-02a\n', 'B2-02a.yaml');
    for (const field of ['repo', 'title', 'type', 'refs', 'refs_hash', 'deps', 'paths', 'impl']) {
      expect(message).toContain(`${field}: missing`);
    }
    expect(message).not.toContain('pr: missing');
  });

  it('requires the id to match the file name', () => {
    expect(messageOf(EXAMPLE, 'ops/tasks/B2-02.yaml')).toContain(
      'id: "B2-02a" does not match the file name "B2-02.yaml"',
    );
  });

  it('rejects absolute, escaping and directory paths', () => {
    const text = EXAMPLE.replace(
      '  - "apps/api/src/modules/ledger/**"',
      '  - "/etc/passwd"\n  - "../couli/**"\n  - "apps/api/"\n  - "a\\\\b"',
    );
    const message = messageOf(text, 'B2-02a.yaml');
    expect(message).toContain('"/etc/passwd" must be relative');
    expect(message).toContain('"../couli/**" must not contain');
    expect(message).toContain('"apps/api/" must name files');
    expect(message).toContain('"a\\b" must use "/" separators');
  });

  it('wraps YAML errors with the file name and rejects non-mapping documents', () => {
    expect(messageOf('id: &a B2-02a\n', 'B2-02a.yaml')).toMatch(/^B2-02a\.yaml: yaml-lite: line 1/);
    expect(messageOf('- a\n', 'B2-02a.yaml')).toContain('the document must be a mapping');
  });
});

describe('loadTask and listTaskIds', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'couli-tasks-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty list when ops/tasks does not exist', () => {
    expect(listTaskIds(root)).toEqual([]);
  });

  it('lists ids in order and skips the archive tree and other files', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(join(dir, 'archive', '202610'), { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    writeFileSync(join(dir, 'B1-01.yaml'), EXAMPLE.replace('id: B2-02a', 'id: B1-01'));
    writeFileSync(join(dir, 'README.md'), 'not a task\n');
    writeFileSync(join(dir, 'archive', '202610', 'A0-01.yaml'), 'id: A0-01\n');
    expect(listTaskIds(root)).toEqual(['B1-01', 'B2-02a']);
  });

  it('loads a task by id from the given root', () => {
    const dir = join(root, 'ops', 'tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'B2-02a.yaml'), EXAMPLE);
    expect(loadTask('B2-02a', root).paths).toEqual(['apps/api/src/modules/ledger/**']);
  });

  it('refuses ids that are not task ids and reports missing files', () => {
    expect(() => loadTask('../../etc/passwd', root)).toThrow(/invalid task id/);
    expect(() => loadTask('B9-99', root)).toThrow(/task file not found/);
  });
});
