import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { findApproval, isGranted, parseApprovals } from './approvals.ts';

const FIXTURE = [
  '# Machine-readable copy of 规划/11 §7.3.',
  'source: "规划/11_开发协作与自主推进.md §7.3"',
  'spec_ref: cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b',
  'approvals:',
  '  - id: 0',
  '    row: 0',
  '    title: "技术栈按 ADR-0001 锁定"',
  '    granted: true',
  '    date: "2026-10-01"',
  '    note: ""',
  '  - id: 1',
  '    row: 1',
  '    title: "Claude 建仓库与规则集"',
  '    granted: false',
  '    date: "2026-10-01"',
  '    note: "示例：未批准"',
  '',
].join('\n');

describe('parseApprovals', () => {
  it('parses the agreed format', () => {
    const file = parseApprovals(FIXTURE);
    expect(file.source).toBe('规划/11_开发协作与自主推进.md §7.3');
    expect(file.spec_ref).toBe('cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b');
    expect(file.approvals).toHaveLength(2);
    expect(findApproval(file, 1)).toEqual({
      id: 1,
      row: 1,
      title: 'Claude 建仓库与规则集',
      granted: false,
      date: '2026-10-01',
      note: '示例：未批准',
    });
  });

  it('grants only entries that exist and are granted', () => {
    const file = parseApprovals(FIXTURE);
    expect(isGranted(file, 0)).toBe(true);
    expect(isGranted(file, 1)).toBe(false);
    expect(isGranted(file, 7)).toBe(false);
  });

  it('never treats a truthy string as granted', () => {
    const text = FIXTURE.replace('granted: false', 'granted: "true"');
    expect(() => parseApprovals(text)).toThrow(/approvals\[1\]\.granted: must be true or false/);
  });

  it('lists every problem', () => {
    const text = [
      'source: ""',
      'approvals:',
      '  - id: 0',
      '    row: zero',
      '    title: ""',
      '    granted: yes',
      '    date: 2026-10-01T00:00:00Z',
      '  - id: 0',
      '    row: 0',
      '    title: "dup"',
      '    granted: true',
      '    date: "2026-10-01"',
      '    note: ""',
      '  - not-a-mapping',
    ].join('\n');
    let message = '';
    try {
      parseApprovals(text);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const part of [
      'source: must be a non-empty string',
      'spec_ref: must be a non-empty string',
      'approvals[0].row: must be a non-negative integer',
      'approvals[0].title: must be a non-empty string',
      'approvals[0].granted: must be true or false',
      'approvals[0].date: must be a quoted date',
      'approvals[0].note: must be a string',
      'approvals[1].id: duplicate id 0',
      'approvals[2]: must be a mapping',
    ]) {
      expect(message).toContain(part);
    }
  });

  it('rejects documents without an approvals list', () => {
    expect(() => parseApprovals('- a\n')).toThrow(/must be a mapping/);
    expect(() => parseApprovals('source: x\nspec_ref: y\n')).toThrow(/approvals: must be a list/);
  });
});

describe('ops/approvals.yaml of this repository', () => {
  it('records rows 0-9 of 规划/11 §7.3 as granted on 2026-10-01 (when the file exists)', () => {
    const file = join(repoRoot(), 'ops', 'approvals.yaml');
    if (!existsSync(file)) {
      // Written by the root package of the skeleton; nothing to check before it exists.
      expect(existsSync(file)).toBe(false);
      return;
    }
    const parsed = parseApprovals(readFileSync(file, 'utf8'));
    expect(parsed.approvals.map((a) => a.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const approval of parsed.approvals) {
      expect(approval.row).toBe(approval.id);
      expect(approval.granted).toBe(true);
      expect(approval.date).toBe('2026-10-01');
    }
  });
});
