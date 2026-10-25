// Runs the compose checker against the real repo, then against fixture repos under .tmp/ to
// prove that every rule can fail and every exemption holds.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkCompose } from './check-compose.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO, 'tools/ci/check-compose.ts');
const SCRATCH = join(REPO, '.tmp', `ci-check-compose-${process.pid}`);

const FULL_SERVICE = [
  '  app:',
  '    image: example:1',
  '    restart: unless-stopped',
  "    cpus: '0.5'",
  '    mem_limit: 256m',
  '    pids_limit: 128',
  '    healthcheck:',
  "      test: ['CMD', 'true']",
  '      interval: 5s',
];

let fixtureCount = 0;

/** Writes the given files (repo-relative path → text) into a fresh scratch root. */
function fixture(files: Record<string, string>): string {
  const root = join(SCRATCH, String(++fixtureCount));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function compose(serviceLines: string[]): string {
  return ['name: fixture', '', 'services:', ...serviceLines, ''].join('\n');
}

function without(prefix: string): string[] {
  const start = FULL_SERVICE.findIndex((line) => line.startsWith(`    ${prefix}`));
  if (start < 0) throw new Error(`no line ${prefix}`);
  let end = start + 1;
  while (end < FULL_SERVICE.length && (FULL_SERVICE[end] ?? '').startsWith('      ')) end++;
  return [...FULL_SERVICE.slice(0, start), ...FULL_SERVICE.slice(end)];
}

function run(root: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], {
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('accepts the real repo (exit 0)', () => {
  expect(checkCompose(REPO)).toEqual([]);
  const result = spawnSync(process.execPath, [SCRIPT, '--root', REPO], { encoding: 'utf8' });
  expect(result.status).toBe(0);
});

it('accepts a long-running service with all four keys', () => {
  const root = fixture({ 'infra/staging/compose.yaml': compose(FULL_SERVICE) });
  expect(checkCompose(root)).toEqual([]);
  expect(run(root).status).toBe(0);
});

for (const key of ['cpus', 'mem_limit', 'pids_limit', 'healthcheck']) {
  it(`reports a long-running service without ${key} (exit 1)`, () => {
    const root = fixture({ 'infra/staging/compose.yaml': compose(without(key)) });
    expect(checkCompose(root).map((p) => p.message)).toEqual([
      `infra/staging/compose.yaml:app: 缺 ${key}`,
    ]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`infra/staging/compose.yaml:app: 缺 ${key}`);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, problems: [{ key }] });
  });
}

it('reports every missing key of a bare long-running service', () => {
  const root = fixture({
    'infra/prod/compose.prod.yaml': compose(['  web:', '    image: x:1', '    restart: always']),
  });
  expect(checkCompose(root).map((p) => p.key)).toEqual([
    'cpus',
    'mem_limit',
    'pids_limit',
    'healthcheck',
  ]);
});

it('treats `healthcheck: disable: true` as missing', () => {
  const lines = [...without('healthcheck'), '    healthcheck:', '      disable: true'];
  const root = fixture({ 'infra/staging/compose.yaml': compose(lines) });
  expect(checkCompose(root).map((p) => p.key)).toEqual(['healthcheck']);
  expect(run(root).status).toBe(1);
});

it('treats a healthcheck without `test` as missing', () => {
  const lines = [...without('healthcheck'), '    healthcheck:', '      interval: 5s'];
  const root = fixture({ 'infra/staging/compose.yaml': compose(lines) });
  expect(checkCompose(root).map((p) => p.key)).toEqual(['healthcheck']);
});

it('does not check a service with `restart: "no"`', () => {
  const root = fixture({
    'infra/staging/compose.yaml': compose(['  job:', '    image: x:1', '    restart: "no"']),
  });
  expect(checkCompose(root)).toEqual([]);
  expect(run(root).status).toBe(0);
});

it('does not check a service without `restart`', () => {
  const root = fixture({
    'infra/local/compose.yaml': compose(['  db:', '    image: x:1']),
  });
  expect(checkCompose(root)).toEqual([]);
  expect(run(root).status).toBe(0);
});

it('skips the allowlisted infra/load/** and infra/fault/** files', () => {
  const bare = compose(['  tool:', '    image: x:1', '    restart: always']);
  const root = fixture({
    'infra/load/k6/compose.yaml': bare,
    'infra/fault/compose.yaml': bare,
  });
  expect(checkCompose(root)).toEqual([]);
  expect(run(root).status).toBe(0);
});

it('a parse failure exits 2 instead of being skipped', () => {
  const root = fixture({
    'infra/staging/compose.yaml': compose([...FULL_SERVICE, '    anchor: &a 1']),
  });
  expect(() => checkCompose(root)).toThrow(/infra\/staging\/compose\.yaml/);
  const result = run(root);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('infra/staging/compose.yaml');
});

it('an unknown argument exits 2', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  expect(result.status).toBe(2);
});
