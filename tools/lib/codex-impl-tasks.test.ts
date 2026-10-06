// The Codex-first task list (owner 2026-10-06, ops/approvals.yaml id 23).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { findApproval, parseApprovals } from '../guard/lib/approvals.ts';
import {
  CODEX_IMPL_TASKS_FILE,
  isCodexFirst,
  isCodexImplTask,
  loadCodexImplTasks,
} from './codex-impl-tasks.ts';
import { repoRoot } from './paths.ts';

it('[approvals 23] lists only tasks of 规划/11 §7.3 row 14, per split task where the row is narrowed, and points at a granted approval', () => {
  const doc = JSON.parse(readFileSync(join(repoRoot(), CODEX_IMPL_TASKS_FILE), 'utf8')) as {
    approval: number;
    tasks: string[];
  };
  expect(doc.tasks.length).toBeGreaterThan(0);
  expect(loadCodexImplTasks(repoRoot())).toEqual(doc.tasks);
  // Rows the exception covers whole, and rows it covers only in part (split tasks named one by one).
  const whole = ['B3-02', 'B3-03', 'QA-06'];
  const partial = ['B3-07', 'B1-14', 'QA-05', 'QA-09'];
  for (const entry of doc.tasks) {
    const row = entry.replace(/[a-z]+$/, '');
    expect([...whole, ...partial], entry).toContain(row);
    if (partial.includes(row))
      expect(entry, 'a narrowed row is listed per split task').not.toBe(row);
  }
  const approvals = parseApprovals(readFileSync(join(repoRoot(), 'ops', 'approvals.yaml'), 'utf8'));
  const entry = findApproval(approvals, doc.approval);
  expect(entry?.granted).toBe(true);
  expect(entry?.row).toBe(14);
});

it('[approvals 23] an entry with a suffix lists that task only; one without lists the whole row', () => {
  const list = ['B3-02', 'B1-14a', 'QA-09c'];
  expect(isCodexImplTask('B3-02', list)).toBe(true);
  expect(isCodexImplTask('B3-02a', list)).toBe(true);
  expect(isCodexImplTask('B3-02ab', list)).toBe(true);
  expect(isCodexImplTask('B1-14a', list)).toBe(true);
  expect(isCodexImplTask('B1-14', list)).toBe(false);
  expect(isCodexImplTask('B1-14b', list)).toBe(false);
  expect(isCodexImplTask('B1-14ab', list)).toBe(false);
  expect(isCodexImplTask('QA-09c', list)).toBe(true);
  expect(isCodexImplTask('B3-01a', list)).toBe(false);
  expect(isCodexImplTask('B3-021', list)).toBe(false);
  expect(isCodexImplTask('B3-02A', list)).toBe(false);
  expect(isCodexImplTask('XB3-02a', list)).toBe(false);
  expect(isCodexFirst({ id: 'B3-02a', impl: 'codex', tester: 'claude' }, list)).toBe(true);
  expect(isCodexFirst({ id: 'B3-02a', impl: 'codex', tester: 'codex' }, list)).toBe(false);
  expect(isCodexFirst({ id: 'B3-02a', impl: 'claude', tester: 'claude' }, list)).toBe(false);
  expect(isCodexFirst({ id: 'B2-01a', impl: 'codex', tester: 'claude' }, list)).toBe(false);
});

it('[approvals 23] a missing or broken list lists nothing; malformed entries are dropped', () => {
  expect(loadCodexImplTasks('/nonexistent')).toEqual([]);
  const root = join(repoRoot(), '.tmp', 'codex-impl-tasks-test');
  mkdirSync(join(root, 'tools', 'guard'), { recursive: true });
  const file = join(root, CODEX_IMPL_TASKS_FILE);
  writeFileSync(file, '{ broken');
  expect(loadCodexImplTasks(root)).toEqual([]);
  writeFileSync(file, JSON.stringify({ tasks: ['B3-02', 'b3-02', 'B3-2', 7, 'B1-14a', 'B1-14A'] }));
  expect(loadCodexImplTasks(root)).toEqual(['B3-02', 'B1-14a']);
  writeFileSync(file, JSON.stringify({ tasks: 'B3-02' }));
  expect(loadCodexImplTasks(root)).toEqual([]);
});
