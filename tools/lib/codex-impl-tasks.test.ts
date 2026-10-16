// The Codex-first task list (owner 2026-10-06, ops/approvals.yaml id 23; owner 2026-10-16, id 30).
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

it('[approvals 23, 30] lists tasks of 规划/11 §7.3 row 14, per split task where the row is narrowed, and other tasks only one by one under row 15; each rests on a granted approval', () => {
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
