// Runs the workflow checker against the real files, then against mutated copies to prove that
// every rule can fail.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkWorkflows, extractEmbeddedProtectedPaths } from './check-workflows.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `ci-check-workflows-${process.pid}`);
const PINNED_CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

let fixtureCount = 0;

/** Copies the real workflows and ruleset into a scratch root and applies one mutation. */
function fixture(mutate: (edit: (file: string, fn: (text: string) => string) => void) => void) {
  const root = join(SCRATCH, String(++fixtureCount));
  mkdirSync(join(root, 'ops'), { recursive: true });
  cpSync(join(REPO, '.github'), join(root, '.github'), { recursive: true });
  cpSync(join(REPO, 'ops/branch-protection.json'), join(root, 'ops/branch-protection.json'));
  mutate((file, fn) => {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const after = fn(before);
    if (after === before) throw new Error(`mutation of ${file} changed nothing`);
    writeFileSync(path, after);
  });
  return root;
}

function codes(root: string): string[] {
  return [...new Set(checkWorkflows(root).map((p) => p.code))].sort();
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('accepts the real workflows and ruleset export', () => {
  expect(checkWorkflows(REPO)).toEqual([]);
});

it('every required context in the ruleset is a job of exactly one real workflow', () => {
  const ruleset = JSON.parse(readFileSync(join(REPO, 'ops/branch-protection.json'), 'utf8')) as {
    bypass_actors: unknown[];
    rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  };
  const contexts = ruleset.rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
  expect(ruleset.bypass_actors).toEqual([]);
  expect(contexts.sort()).toEqual(
    [
      'ci-gate',
      'contracts-gate',
      'evidence-check',
      'gitleaks',
      'longrun-props',
      'protected-paths',
    ].sort(),
  );
});

it('the embedded protected-paths list parses and carries the three classes', () => {
  const text = readFileSync(join(REPO, '.github/workflows/protected-paths.yml'), 'utf8');
  const embedded = extractEmbeddedProtectedPaths(text);
  const parsed = JSON.parse(embedded ?? 'null') as Record<string, string[]>;
  expect(Object.keys(parsed).sort()).toEqual([
    'class1_add_only',
    'class2_verify_config',
    'class3_gates',
  ]);
  expect(parsed['class3_gates']).toContain('.github/**');
});

it('rejects an action pinned to a tag instead of a commit SHA', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace(PINNED_CHECKOUT, 'actions/checkout@v7')),
  );
  expect(codes(root)).toEqual(['unpinned-action']);
});

it('rejects a pinned action without a version comment', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) => t.replace(' # v7.0.1', '')),
  );
  expect(codes(root)).toEqual(['unpinned-action']);
});

it('rejects workflow-level paths filters', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/contracts.yml', (t) =>
      t.replace('  pull_request:\n', "  pull_request:\n    paths: ['contracts/**']\n"),
    ),
  );
  expect(codes(root)).toEqual(['workflow-paths']);
});

it('rejects a job name that is used in two workflows', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/contracts.yml', (t) => t.replace('  contracts-detect:', '  gitleaks:')),
  );
  expect(codes(root)).toContain('duplicate-job');
});

it('rejects a required context that no job reports', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace('  ci-gate:', '  ci-summary:')),
  );
  expect(codes(root)).toEqual(['required-context']);
});

it('rejects a required summary job that can be skipped', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace(
        '    if: always()\n    needs: [verify-fast',
        '    if: success()\n    needs: [verify-fast',
      ),
    ),
  );
  expect(codes(root)).toEqual(['required-job-condition']);
});

it('rejects a checkout in the pull_request_target workflow', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace('    steps:\n', `    steps:\n      - uses: ${PINNED_CHECKOUT}\n`),
    ),
  );
  expect(codes(root)).toEqual(['prt-checkout', 'prt-uses']);
});

it('rejects a second pull_request_target workflow', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('  pull_request:\n', '  pull_request_target:\n'),
    ),
  );
  expect(codes(root)).toContain('prt-count');
});

it('rejects an embedded protected-paths list that is not valid JSON', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace('"class3_gates": [', '"class3_gates": [,'),
    ),
  );
  expect(codes(root)).toEqual(['protected-json']);
});

it('rejects an embedded protected-paths list with an empty class', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/protected-paths.yml', (t) =>
      t.replace(/"class1_add_only": \[[^\]]*\]/, '"class1_add_only": []'),
    ),
  );
  expect(codes(root)).toEqual(['protected-json']);
});

it('rejects a ruleset with bypass actors', () => {
  const root = fixture((edit) =>
    edit('ops/branch-protection.json', (t) =>
      t.replace(
        '"bypass_actors": []',
        '"bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]',
      ),
    ),
  );
  expect(codes(root)).toEqual(['ruleset']);
});

it('rejects a required check that is not pinned to the Actions integration', () => {
  const root = fixture((edit) =>
    edit('ops/branch-protection.json', (t) =>
      t.replace('{ "context": "gitleaks", "integration_id": 15368 }', '{ "context": "gitleaks" }'),
    ),
  );
  expect(codes(root)).toEqual(['ruleset']);
});

it('rejects ubuntu-slim runners', () => {
  const root = fixture((edit) =>
    edit('.github/workflows/gitleaks.yml', (t) =>
      t.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-slim'),
    ),
  );
  expect(codes(root)).toEqual(['runs-on']);
});

it('rejects write permissions and permission shorthands', () => {
  const write = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace('  contents: read', '  contents: write')),
  );
  const shorthand = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) =>
      t.replace('permissions:\n  contents: read', 'permissions: write-all'),
    ),
  );
  expect([codes(write), codes(shorthand)]).toEqual([['permissions'], ['permissions']]);
});

it('CLI exit codes: 0 for the real repo, 1 for a broken copy, 2 for bad usage', () => {
  const broken = fixture((edit) =>
    edit('.github/workflows/ci.yml', (t) => t.replace(PINNED_CHECKOUT, 'actions/checkout@main')),
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(REPO, 'tools/ci/check-workflows.ts'), ...args], {
      encoding: 'utf8',
    });
  const ok = run(['--json']);
  const bad = run(['--root', broken, '--json']);
  const usage = run(['--nope']);
  expect([ok.status, bad.status, usage.status]).toEqual([0, 1, 2]);
  expect(JSON.parse(ok.stdout)).toEqual({ ok: true, problems: [] });
  expect((JSON.parse(bad.stdout) as { ok: boolean }).ok).toBe(false);
}, 60_000);
