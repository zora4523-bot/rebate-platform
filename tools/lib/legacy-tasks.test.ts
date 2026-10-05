// The switch-baseline ledger list (Codex review CR2-02).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LEGACY_TASKS_FILE, loadLegacyTasks, needsTestPaths } from './legacy-tasks.ts';
import { repoRoot } from './paths.ts';

it('[CR2-02] lists the ledgers on origin/main when the switch was merged, each still in the ledger or its archive', () => {
  const doc = JSON.parse(readFileSync(join(repoRoot(), LEGACY_TASKS_FILE), 'utf8')) as {
    baseline: string;
    tasks: string[];
  };
  expect(doc.baseline).toBe('b97ee61593c47a72f3aa6b53d790916fdb177568');
  expect(doc.tasks).toHaveLength(70);
  const archive = join(repoRoot(), 'ops', 'tasks', 'archive');
  const months = existsSync(archive) ? readdirSync(archive) : [];
  for (const id of doc.tasks) {
    const places = [
      join(repoRoot(), 'ops', 'tasks', `${id}.yaml`),
      ...months.map((m) => join(archive, m, `${id}.yaml`)),
    ];
    expect(
      places.some((p) => existsSync(p)),
      id,
    ).toBe(true);
  }
});

it('[CR2-02] only a listed ledger with a rule-test author may omit test_paths; a missing list lists none', () => {
  const legacy = loadLegacyTasks(repoRoot());
  expect(needsTestPaths({ id: 'B2-01a', tester: 'claude' }, legacy)).toBe(false);
  expect(needsTestPaths({ id: 'B2-02z', tester: 'codex' }, legacy)).toBe(true);
  expect(needsTestPaths({ id: 'B2-02z', tester: 'none' }, legacy)).toBe(false);
  expect(loadLegacyTasks('/nonexistent').size).toBe(0);
});
