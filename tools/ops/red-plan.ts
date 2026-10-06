// Plan of the isolated red run (tools/ops/verify-container.sh --red; 规划/11 §2.3 step 3; Codex
// review CR2-04): which trusted Vitest project runs each expected rule-test file. A file that no
// project takes has no execution entry: the plan fails (exit 1) instead of leaving it out.
//
//   node tools/ops/red-plan.ts --expected <file>   (one repository path per line)
//
// Prints one JSON document: { groups: [{ name, dir, config, database, browser, files }] } with
// `files` relative to `dir`; `browser` marks a group that runs in a real Chromium (the verify image
// must have Playwright's browser). Exit codes: 0 planned, 1 a file has no execution entry, 2 usage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { matchesAny } from '../lib/glob.ts';
import { runMain, UsageError, CheckError } from './cli.ts';

export type RedProject = {
  name: string;
  dir: string;
  config: string;
  include: string[];
  exclude: string[];
  database: boolean;
  /** Runs in a real Chromium (Vitest browser mode, F1-01j). */
  browser: boolean;
};

export type RedGroup = {
  name: string;
  dir: string;
  config: string;
  database: boolean;
  browser: boolean;
  files: string[];
};

export function loadRedProjects(
  file = join(import.meta.dirname, 'verify-image', 'red-projects.json'),
): RedProject[] {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { projects?: RedProject[] };
  if (!Array.isArray(doc.projects)) throw new Error(`${file}: projects missing`);
  for (const p of doc.projects) {
    if (typeof p.database !== 'boolean' || typeof p.browser !== 'boolean') {
      throw new Error(`${file}: project ${String(p.name)} needs boolean database and browser`);
    }
  }
  return doc.projects;
}

/** Groups the expected files by project; `unrunnable` lists the files no project takes. */
export function planRed(
  expected: readonly string[],
  projects: readonly RedProject[],
): { groups: RedGroup[]; unrunnable: string[] } {
  const groups = new Map<string, RedGroup>();
  const unrunnable: string[] = [];
  for (const file of expected) {
    const project = projects.find((p) => {
      if (!file.startsWith(`${p.dir}/`)) return false;
      const rel = file.slice(p.dir.length + 1);
      return matchesAny(rel, p.include) && !matchesAny(rel, p.exclude);
    });
    if (project === undefined) {
      unrunnable.push(file);
      continue;
    }
    const group = groups.get(project.name) ?? {
      name: project.name,
      dir: project.dir,
      config: project.config,
      database: project.database,
      browser: project.browser,
      files: [],
    };
    group.files.push(file.slice(project.dir.length + 1));
    groups.set(project.name, group);
  }
  return { groups: [...groups.values()], unrunnable };
}

function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { expected: { type: 'string' } } });
  if (values.expected === undefined) throw new UsageError('red-plan.ts --expected <file>');
  const expected = readFileSync(values.expected, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const plan = planRed(expected, loadRedProjects());
  if (plan.unrunnable.length > 0) {
    throw new CheckError(
      `no execution entry for: ${plan.unrunnable.join(', ')} (none of the Vitest projects in tools/ops/verify-image/red-projects.json runs them)`,
    );
  }
  console.log(JSON.stringify({ groups: plan.groups }));
  return 0;
}

if (import.meta.main) runMain(main);
