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
  /**
   * Where the rule-test author may write the task's rule tests (globs inside class 1 of the
   * protected paths); optional, [] when absent. The test phase of a task with a rule-test author
   * needs it (default split of 2026-10-05, ops/approvals.yaml id 19; 规划/11 §2.3 step 2).
   */
  test_paths: string[];
  /**
   * Codex implementation ledgers only (ops/approvals.yaml id 31): the generated or marker files
   * a Claude commit marked `Couli-Mechanical: contract-codegen` may change in the same pull
   * request (remove `x-implementation: planned` from the contract and regenerate). Never handed
   * to Codex and never part of `paths`; optional, [] when absent. Allowed values: the
   * `mechanical_paths` of tools/guard/codex-impl-tasks.json (task.ts check).
   */
  mechanical_paths: string[];
  /**
   * CT-06r: red-run exemptions the task declares for tests of a rule-test file that existed at
   * the base, whose block is unchanged, in a file that red-check would otherwise judge as a whole
   * only because it may read a test-support file (a fixture, helper or data file inside
   * test_paths) the task changed: such a test (a structural assertion that holds for the old
   * data too) cannot be shown red for a valid reason. Each entry names the file (inside
   * test_paths), the test's full name as the red report gives it and a reason of at least 10
   * characters; the rule-test reviewer confirms them in the evidence
   * (spec_test_review.red_exempt_confirmed, tools/ci/evidence-check.ts). Optional, [] when absent.
   * Read from the trusted root like test_paths, so a declaration goes through a ledger PR first.
   */
  red_exempt: RedExemptDeclaration[];
  impl: 'codex' | 'claude';
  tester: 'codex' | 'claude' | 'none';
  accept: string[];
  status: 'todo' | 'done';
  pr: number | null;
};

/** One declared red-run exemption (CT-06r). */
export type RedExemptDeclaration = {
  /** The rule-test file, repository-relative, inside the task's test_paths. */
  file: string;
  /** The test's full name as the red reporter writes it (`describe > … > title`). */
  test: string;
  /** Why the test cannot be shown red (at least RED_EXEMPT_REASON_MIN characters). */
  reason: string;
};

/** The least a red-exemption reason may say (CT-06r: a non-empty reason of ≥ 10 characters). */
export const RED_EXEMPT_REASON_MIN = 10;

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
  'test_paths',
  'mechanical_paths',
  'red_exempt',
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
  if (/[\u0000-\u001f\u007f]/.test(glob)) return 'must not contain control characters';
  if (glob.startsWith('/')) return 'must be relative to the repository root';
  if (glob.includes('\\')) return 'must use "/" separators';
  if (glob.split('/').some((seg) => seg === '..' || seg === '.')) {
    return 'must not contain "." or ".." segments';
  }
  if (glob.endsWith('/')) return 'must name files (end with a file name or a wildcard)';
  return null;
}

/**
 * The `red_exempt` list (CT-06r): a list of mappings `file` / `test` / `reason`, each a non-empty
 * string, the file a repository-relative path, the reason at least RED_EXEMPT_REASON_MIN
 * characters once trimmed, and no file + test named twice. Whether the file lies inside
 * test_paths and the task has a rule-test author is checked by tools/ops/task.ts.
 */
function redExemptList(value: unknown, problems: string[]): RedExemptDeclaration[] {
  if (!Array.isArray(value)) {
    problems.push('red_exempt: must be a list of mappings (file / test / reason)');
    return [];
  }
  const out: RedExemptDeclaration[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`red_exempt[${index}]: must be a mapping (file / test / reason)`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!['file', 'test', 'reason'].includes(key)) {
        problems.push(`red_exempt[${index}].${key}: unknown field`);
      }
    }
    const file = item['file'];
    const test = item['test'];
    const reason = item['reason'];
    let ok = true;
    if (typeof file !== 'string' || file === '') {
      problems.push(`red_exempt[${index}].file: must be a non-empty repository path`);
      ok = false;
    } else {
      const problem = pathProblem(file);
      if (problem !== null) {
        problems.push(`red_exempt[${index}].file: "${file}" ${problem}`);
        ok = false;
      }
    }
    if (typeof test !== 'string' || test.trim() === '') {
      problems.push(`red_exempt[${index}].test: must be the test's full name (non-empty)`);
      ok = false;
    }
    if (typeof reason !== 'string' || reason.trim().length < RED_EXEMPT_REASON_MIN) {
      problems.push(
        `red_exempt[${index}].reason: must say why the test cannot be shown red (at least ${RED_EXEMPT_REASON_MIN} characters)`,
      );
      ok = false;
    }
    if (!ok) return;
    const key = `${file as string}\u0000${test as string}`;
    if (seen.has(key)) {
      problems.push(
        `red_exempt[${index}]: "${file as string} > ${test as string}" is declared twice`,
      );
      return;
    }
    seen.add(key);
    out.push({ file: file as string, test: test as string, reason: reason as string });
  });
  return out;
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
    if (
      key !== 'pr' &&
      key !== 'contract_sections' &&
      key !== 'test_paths' &&
      key !== 'mechanical_paths' &&
      key !== 'red_exempt' &&
      !Object.hasOwn(doc, key)
    ) {
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
  const testPaths = Object.hasOwn(doc, 'test_paths')
    ? stringList(doc, 'test_paths', problems, { nonEmpty: true })
    : [];
  for (const glob of testPaths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`test_paths: "${glob}" ${problem}`);
  }
  const mechanicalPaths = Object.hasOwn(doc, 'mechanical_paths')
    ? stringList(doc, 'mechanical_paths', problems, { nonEmpty: true })
    : [];
  for (const glob of mechanicalPaths) {
    const problem = pathProblem(glob);
    if (problem) problems.push(`mechanical_paths: "${glob}" ${problem}`);
  }
  const redExempt = Object.hasOwn(doc, 'red_exempt')
    ? redExemptList(doc['red_exempt'], problems)
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
    test_paths: testPaths,
    mechanical_paths: mechanicalPaths,
    red_exempt: redExempt,
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
