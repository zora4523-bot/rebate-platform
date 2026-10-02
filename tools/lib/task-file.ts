// Task ledger files `ops/tasks/<id>.yaml` (规划/11 §2.1; format: planning repo
// docs/templates/task-ledger.md). Shape validation only: cross-file rules (id prefix exists in
// 规划/05, impl != tester for funds, line cap, dependency state) live in tools/ops.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { repoRoot } from './paths.ts';
import { parseYamlLite } from './yaml-lite.ts';

export type TaskFile = {
  id: string;
  repo: 'rebate-platform' | 'ios' | 'android' | 'harmony';
  title: string;
  type: 'impl' | 'contract' | 'migration' | 'deps' | 'test-change' | 'guard-change' | 'sync';
  refs: string[];
  refs_hash: Record<string, string>;
  /**
   * Contract tasks only: the 规划/04 sections the brief quotes (e.g. "2", "6.1"); optional,
   * [] when absent (owner decision 2026-10-02, ops/approvals.yaml id 17).
   */
  contract_sections: string[];
  deps: string[];
  paths: string[];
  impl: 'codex' | 'claude';
  tester: 'codex' | 'claude' | 'none';
  accept: string[];
  status: 'todo' | 'done';
  pr: number | null;
};

export const TASK_REPOS = ['rebate-platform', 'ios', 'android', 'harmony'] as const;
export const TASK_TYPES = [
  'impl',
  'contract',
  'migration',
  'deps',
  'test-change',
  'guard-change',
  'sync',
] as const;
export const TASK_IMPLS = ['codex', 'claude'] as const;
export const TASK_TESTERS = ['codex', 'claude', 'none'] as const;
export const TASK_STATUSES = ['todo', 'done'] as const;

/** A section number of 规划/04 as written in its headings: "2", "6.1", "10.2". */
export const CONTRACT_SECTION_PATTERN = /^[1-9][0-9]*(\.[1-9][0-9]*)*$/;

/** Task ids become file names, branch names and run directories: 规划/05 ids plus a suffix. */
export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$/;

const KNOWN_KEYS = new Set([
  'id',
  'repo',
  'title',
  'type',
  'refs',
  'refs_hash',
  'contract_sections',
  'deps',
  'paths',
  'impl',
  'tester',
  'accept',
  'status',
  'pr',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function stringList(
  doc: Record<string, unknown>,
  key: string,
  problems: string[],
  opts: { nonEmpty: boolean },
): string[] {
  const value = doc[key];
  if (!Array.isArray(value)) {
    problems.push(`${key}: must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item === '') {
      problems.push(`${key}[${index}]: must be a non-empty string`);
    } else {
      out.push(item);
    }
  });
  if (opts.nonEmpty && value.length === 0) problems.push(`${key}: must not be empty`);
  return out;
}

function pathProblem(glob: string): string | null {
  if (glob.startsWith('/')) return 'must be relative to the repository root';
  if (glob.includes('\\')) return 'must use "/" separators';
  if (glob.split('/').some((seg) => seg === '..' || seg === '.')) {
    return 'must not contain "." or ".." segments';
  }
  if (glob.endsWith('/')) return 'must name files (end with a file name or a wildcard)';
  return null;
}

/** Parses and validates one task file; throws a single Error listing every problem found. */
export function parseTaskFile(text: string, fileName: string): TaskFile {
  const label = basename(fileName);
  let doc: unknown;
  try {
    doc = parseYamlLite(text);
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc)) throw new Error(`${label}: the document must be a mapping`);

  const problems: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`${key}: unknown field`);
  }
  for (const key of KNOWN_KEYS) {
    if (key !== 'pr' && key !== 'contract_sections' && !Object.hasOwn(doc, key)) {
      problems.push(`${key}: missing`);
    }
  }

  const id = doc['id'];
  if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
    if (Object.hasOwn(doc, 'id')) problems.push('id: must look like "B2-03" or "B2-03a"');
  } else if (label.replace(/\.ya?ml$/, '') !== id) {
    problems.push(`id: "${id}" does not match the file name "${label}"`);
  }

  const repo = doc['repo'];
  if (Object.hasOwn(doc, 'repo') && !oneOf(repo, TASK_REPOS)) {
    problems.push(`repo: must be one of ${TASK_REPOS.join(' / ')}`);
  }

  const title = doc['title'];
  if (Object.hasOwn(doc, 'title')) {
    if (typeof title !== 'string' || title.trim() === '' || title.includes('\n')) {
      problems.push('title: must be a single non-empty line');
    }
  }

  const type = doc['type'];
  if (Object.hasOwn(doc, 'type') && !oneOf(type, TASK_TYPES)) {
    problems.push(`type: must be one of ${TASK_TYPES.join(' / ')}`);
  }

  const refs = Object.hasOwn(doc, 'refs')
    ? stringList(doc, 'refs', problems, { nonEmpty: false })
    : [];
  const deps = Object.hasOwn(doc, 'deps')
    ? stringList(doc, 'deps', problems, { nonEmpty: false })
    : [];
  const paths = Object.hasOwn(doc, 'paths')
    ? stringList(doc, 'paths', problems, { nonEmpty: true })
    : [];
  const accept = Object.hasOwn(doc, 'accept')
    ? stringList(doc, 'accept', problems, { nonEmpty: true })
    : [];

  const contractSections = Object.hasOwn(doc, 'contract_sections')
    ? stringList(doc, 'contract_sections', problems, { nonEmpty: true })
    : [];
  if (Object.hasOwn(doc, 'contract_sections') && type !== 'contract') {
    problems.push('contract_sections: only a contract task names 规划/04 sections');
  }
  for (const section of contractSections) {
    if (!CONTRACT_SECTION_PATTERN.test(section)) {
      problems.push(
        `contract_sections: "${section}" is not a 规划/04 section number such as "6.1"`,
      );
    }
  }

  for (const dep of deps) {
    if (!TASK_ID_PATTERN.test(dep)) problems.push(`deps: "${dep}" is not a task id`);
  }
  for (const glob of paths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`paths: "${glob}" ${problem}`);
  }

  const refsHash: Record<string, string> = {};
  if (Object.hasOwn(doc, 'refs_hash')) {
    const raw = doc['refs_hash'];
    if (!isRecord(raw)) {
      problems.push('refs_hash: must be a mapping of reference id to hash');
    } else {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || value === '') {
          problems.push(`refs_hash.${key}: must be a non-empty string`);
        } else {
          refsHash[key] = value;
        }
      }
    }
  }

  const impl = doc['impl'];
  if (Object.hasOwn(doc, 'impl') && !oneOf(impl, TASK_IMPLS)) {
    problems.push(`impl: must be one of ${TASK_IMPLS.join(' / ')}`);
  }
  const tester = doc['tester'];
  if (Object.hasOwn(doc, 'tester') && !oneOf(tester, TASK_TESTERS)) {
    problems.push(`tester: must be one of ${TASK_TESTERS.join(' / ')}`);
  }
  const status = doc['status'];
  if (Object.hasOwn(doc, 'status') && !oneOf(status, TASK_STATUSES)) {
    problems.push(`status: must be one of ${TASK_STATUSES.join(' / ')}`);
  }

  const pr = doc['pr'] ?? null;
  if (pr !== null && (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0)) {
    problems.push('pr: must be a positive integer or null');
  }

  if (problems.length > 0) {
    throw new Error(`${label}: invalid task file\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return {
    id: id as string,
    repo: repo as TaskFile['repo'],
    title: title as string,
    type: type as TaskFile['type'],
    refs,
    refs_hash: refsHash,
    contract_sections: contractSections,
    deps,
    paths,
    impl: impl as TaskFile['impl'],
    tester: tester as TaskFile['tester'],
    accept,
    status: status as TaskFile['status'],
    pr: pr as number | null,
  };
}

/** Reads `<root>/ops/tasks/<id>.yaml` (root defaults to this checkout). */
export function loadTask(id: string, root: string = repoRoot()): TaskFile {
  if (!TASK_ID_PATTERN.test(id)) throw new Error(`invalid task id: "${id}"`);
  const file = join(root, 'ops', 'tasks', `${id}.yaml`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`task file not found: ${file}`);
  }
  return parseTaskFile(text, file);
}

/** Ids of the task files directly under `<root>/ops/tasks` (the `archive/` tree is excluded). */
export function listTaskIds(root: string = repoRoot()): string[] {
  const dir = join(root, 'ops', 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name.slice(0, -'.yaml'.length))
    .sort();
}
