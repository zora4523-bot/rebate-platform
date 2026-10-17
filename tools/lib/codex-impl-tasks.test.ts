// The Codex-first task list (owner 2026-10-06, ops/approvals.yaml id 23; owner 2026-10-16, id 30;
// frozen since 2026-10-17, id 34: implementation is back with Claude, Codex reviews only).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { findApproval, parseApprovals } from '../guard/lib/approvals.ts';
import { MONEY_PATHS } from '../ci/evidence-check.ts';
import { globsMayOverlap } from '../ops/overlap.ts';
import { archivedTaskIds } from '../ops/task.ts';
import {
  CODEX_IMPL_TASKS_FILE,
  isCodexFirst,
  isCodexImplTask,
  loadCodexImplForbidden,
  loadCodexImplMechanical,
  loadCodexImplTasks,
} from './codex-impl-tasks.ts';
import { repoRoot } from './paths.ts';
import { listTaskIds } from './task-file.ts';

// The list as it stood when the owner moved implementation back to Claude (2026-10-17,
// ops/approvals.yaml id 34, superseding id 30). A listed task already started finishes as a
// Codex implementation (ids 31, 33); one not yet started goes back to impl: claude at its next
// ledger PR and leaves the list. Entries may only be removed from here, never added.
const FROZEN_2026_10_17 = [
  'B3-02',
  'B3-03',
  'QA-06',
  'B3-07a',
  'B3-07b',
  'B1-14a',
  'B1-14b',
  'B1-14c',
  'QA-05a',
  'QA-05b',
  'QA-05c',
  'QA-09a',
  'QA-09b',
  'QA-09c',
  'F1-02d',
  'B1-17b',
  'B1-17c',
  'B1-29a',
  'B1-28b',
  'F1-02e',
  'F1-02f',
  'F1-10b',
  'F1-10c',
  'F1-10d',
  'F1-10e',
  'B1-02d',
  'B1-20a',
  'B1-02z',
  'B1-02y',
  'F1-06zd',
  'F1-06ze',
  'F1-02h',
  'B1-12c',
  'B1-12d',
  'B1-11b',
  'B1-20d',
  'F1-07b',
];

it('[approvals 34] the list is frozen since 2026-10-17: no entry outside the set of that day (removals only)', () => {
  const doc = JSON.parse(readFileSync(join(repoRoot(), CODEX_IMPL_TASKS_FILE), 'utf8')) as {
    tasks: string[];
  };
  const approvals = parseApprovals(readFileSync(join(repoRoot(), 'ops', 'approvals.yaml'), 'utf8'));
  expect(findApproval(approvals, 34)?.granted, 'id 34 (row 16) is granted').toBe(true);
  expect(findApproval(approvals, 34)?.row).toBe(16);
  for (const task of doc.tasks) {
    expect(
      FROZEN_2026_10_17.includes(task),
      `${task}: not in the frozen list of 2026-10-17; a new task is a Claude implementation (ops/approvals.yaml id 34)`,
    ).toBe(true);
  }
  expect(new Set(doc.tasks).size, 'no duplicate entry').toBe(doc.tasks.length);
});

it('[approvals 23, 30, 34] lists tasks of 规划/11 §7.3 row 14, per split task where the row is narrowed, and other tasks only one by one under row 15 (frozen by row 16 since 2026-10-17); each rests on a granted approval', () => {
  const doc = JSON.parse(readFileSync(join(repoRoot(), CODEX_IMPL_TASKS_FILE), 'utf8')) as {
    approval: number;
    tasks: string[];
  };
  expect(doc.tasks.length).toBeGreaterThan(0);
  expect(loadCodexImplTasks(repoRoot())).toEqual(doc.tasks);
  const approvals = parseApprovals(readFileSync(join(repoRoot(), 'ops', 'approvals.yaml'), 'utf8'));
  const entry = findApproval(approvals, doc.approval);
  expect(entry?.granted).toBe(true);
  expect(entry?.row).toBe(14);
  // Row 14: rows the exception covers whole, and rows it covers only in part (split tasks named
  // one by one).
  const whole = ['B3-02', 'B3-03', 'QA-06'];
  const partial = ['B3-07', 'B1-14', 'QA-05', 'QA-09'];
  // Row 15 (id 30): any other task not yet started, listed under the id of its ledger (ops/tasks
  // or its archive), never as a bare 规划/05 row, which would also let through split tasks
  // already started. Whether a task had started is checked by the orchestrator when listing it.
  const unstarted = approvals.approvals.filter((a) => a.row === 15 && a.granted);
  const ledgers = new Set([...listTaskIds(repoRoot()), ...archivedTaskIds(repoRoot())]);
  for (const task of doc.tasks) {
    const row = task.replace(/[a-z]+$/, '');
    if ([...whole, ...partial].includes(row)) {
      if (partial.includes(row))
        expect(task, 'a narrowed row is listed per split task').not.toBe(row);
      continue;
    }
    expect(
      unstarted.length,
      `${task}: outside row 14 needs a granted approval of row 15`,
    ).toBeGreaterThan(0);
    expect(ledgers.has(task), `${task}: a task of row 15 is listed under its ledger id`).toBe(true);
  }
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

it('[approvals 23] forbidden_paths cover every funds and attribution path of evidence-check (MONEY_PATHS)', () => {
  const forbidden = loadCodexImplForbidden(repoRoot());
  for (const glob of MONEY_PATHS) {
    const expanded = glob.includes('{')
      ? glob
          .replace(/^(.*)\{([^}]*)\}(.*)$/, (_m, a: string, list: string, b: string) =>
            list
              .split(',')
              .map((x) => `${a}${x}${b}`)
              .join('|'),
          )
          .split('|')
      : [glob];
    for (const g of expanded) {
      expect(
        forbidden.some((f) => globsMayOverlap(g, f)),
        g,
      ).toBe(true);
    }
  }
});

it('[approvals 33] the H5 and admin frontends are open to a Codex ledger; every other client and gate stays forbidden', () => {
  const forbidden = loadCodexImplForbidden(repoRoot());
  for (const open of ['apps/h5/src/pages/home.tsx', 'apps/admin/src/main.tsx']) {
    expect(
      forbidden.some((f) => globsMayOverlap(open, f)),
      open,
    ).toBe(false);
  }
  for (const closed of [
    'apps/ios/App.swift',
    'apps/android/app/build.gradle',
    'apps/harmony/entry/index.ets',
    'contracts/openapi.yaml',
    'db/migrations/0001_init.sql',
    'packages/money/src/index.ts',
    'packages/domain/src/index.ts',
    'apps/api/src/modules/payout/payout.service.ts',
    '.github/workflows/ci.yml',
    'tools/ops/task.ts',
    'ops/approvals.yaml',
    'specs/commission-examples.csv',
  ]) {
    expect(
      forbidden.some((f) => globsMayOverlap(closed, f)),
      closed,
    ).toBe(true);
  }
});

it('[approvals 31] mechanical_paths are exact files, each generated file under a required drift check, the contract the only other', () => {
  const mechanical = loadCodexImplMechanical(repoRoot());
  expect(mechanical).toContain('contracts/openapi.yaml');
  const forbidden = loadCodexImplForbidden(repoRoot());
  const contractsWorkflow = readFileSync(
    join(repoRoot(), '.github', 'workflows', 'contracts.yml'),
    'utf8',
  );
  for (const path of mechanical) {
    // One file each, no glob: a glob would let a mechanical commit reach more than it names.
    expect(path, 'a mechanical path is one file').toMatch(/^[A-Za-z0-9._/-]+$/);
    if (path.startsWith('contracts/') || path.startsWith('packages/contracts-ts/')) {
      // The contract and its client stay out of reach of a Codex ledger's paths.
      expect(
        forbidden.some((f) => globsMayOverlap(path, f)),
        path,
      ).toBe(true);
    }
    if (path === 'contracts/openapi.yaml') continue;
    expect(path, 'any other mechanical path is a generated file').toMatch(/\.gen\.ts$/);
    if (path.startsWith('packages/contracts-ts/')) {
      // contracts-gate runs `pnpm contracts:check` (codegen --check) when this directory changes.
      expect(contractsWorkflow).toContain(
        'git diff --quiet "$base" HEAD -- contracts packages/contracts-ts',
      );
      expect(contractsWorkflow).toContain('pnpm contracts:check');
    } else {
      // A generated file outside the contracts workflow needs a test of ci-gate comparing it with
      // a fresh generation (contract-routes.test.ts for route-schemas.gen.ts).
      const dir = path.slice(0, path.lastIndexOf('/'));
      const test = readFileSync(join(repoRoot(), dir, 'contract-routes.test.ts'), 'utf8');
      expect(test).toContain(
        "expect(await readFile(routeSchemasFile, 'utf8')).toBe(await routeSchemasSource());",
      );
    }
  }
});
