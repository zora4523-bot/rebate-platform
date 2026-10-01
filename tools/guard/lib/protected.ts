// Protected paths (规划/11 §4.4). Single source: tools/guard/protected-paths.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../../lib/fsx.ts';
import { showFile, existsAt } from '../../lib/git.ts';
import type { Change } from '../../lib/git.ts';
import { globToRegExp, hasWildcard } from '../../lib/glob.ts';

export type ProtectedClass = 1 | 2 | 3;

export type ProtectedConfig = {
  class1_add_only: string[];
  class2_verify_config: string[];
  class3_gates: string[];
};

const KEYS = ['class1_add_only', 'class2_verify_config', 'class3_gates'] as const;

/** The lock file may change in a `deps` task (规划/11 §4.4, class 2). */
const DEPS_TASK_EXEMPT = new Set(['pnpm-lock.yaml']);

export function parseProtected(value: unknown): ProtectedConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('protected-paths.json: must be an object');
  }
  const doc = value as Record<string, unknown>;
  const extra = Object.keys(doc).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`protected-paths.json: unknown keys ${extra.join(', ')}`);
  const out: Record<string, string[]> = {};
  for (const key of KEYS) {
    const list = doc[key];
    if (!Array.isArray(list) || list.length === 0 || !list.every((g) => typeof g === 'string')) {
      throw new Error(`protected-paths.json: ${key} must be a non-empty list of globs`);
    }
    for (const glob of list as string[]) globToRegExp(splitFragment(glob).glob);
    out[key] = list as string[];
  }
  return out as ProtectedConfig;
}

export function loadProtected(root: string): ProtectedConfig {
  return parseProtected(readJsonFile(join(root, 'tools', 'guard', 'protected-paths.json')));
}

// A rule such as "<glob>/package.json#scripts" protects only the top-level `scripts` key of the
// matching JSON files.
export function splitFragment(glob: string): { glob: string; fragment: string | null } {
  const hash = glob.lastIndexOf('#');
  if (hash <= 0) return { glob, fragment: null };
  return { glob: glob.slice(0, hash), fragment: glob.slice(hash + 1) };
}

const regexCache = new Map<string, RegExp>();

// Protected paths are matched case-insensitively: on a case-insensitive file system
// `agents.md` or `.Claude/settings.json` would be read in place of the protected name.
function matchesCI(path: string, glob: string): boolean {
  const key = glob.toLowerCase();
  let re = regexCache.get(key);
  if (!re) {
    re = globToRegExp(key);
    regexCache.set(key, re);
  }
  return re.test(path.normalize('NFC').toLowerCase());
}

function literalPrefix(glob: string): string {
  const m = /[*?{]/.exec(glob);
  return m ? glob.slice(0, m.index) : glob;
}

/**
 * True when every file the input can name is matched by `rule`.
 * A literal input is matched directly. A glob input is covered only by an identical rule, by
 * `**`, or by a directory rule `<dir>/**` whose directory is a literal prefix of the input.
 */
export function covers(rule: string, input: string, caseInsensitive = false): boolean {
  const r = caseInsensitive ? rule.toLowerCase() : rule;
  const i = caseInsensitive ? input.toLowerCase() : input;
  if (!hasWildcard(i)) return globToRegExp(r).test(i.normalize('NFC'));
  if (r === i || r === '**') return true;
  if (r.endsWith('/**') && !hasWildcard(r.slice(0, -3))) {
    return literalPrefix(i).startsWith(r.slice(0, -2));
  }
  return false;
}

const CLASS_ORDER: [ProtectedClass, (typeof KEYS)[number]][] = [
  [3, 'class3_gates'],
  [2, 'class2_verify_config'],
  [1, 'class1_add_only'],
];

/**
 * Path-level class of a literal path or of a task glob (highest class wins). Fragment rules
 * (`#scripts`) count by their path part here; whether the protected key really changed is
 * decided by findProtectedHits(), which sees the diff.
 */
export function classOfPath(input: string, cfg: ProtectedConfig): ProtectedClass | null {
  for (const [cls, key] of CLASS_ORDER) {
    for (const glob of cfg[key]) {
      if (covers(splitFragment(glob).glob, input, true)) return cls;
    }
  }
  return null;
}

export type ProtectedHit = { path: string; class: ProtectedClass; rule: string; change: string };

export type ContentReaders = {
  /** Content at the base commit, or null when the file does not exist there. */
  readBase: (path: string) => string | null;
  /** Content in the working tree, or null when the file does not exist. */
  readWork: (path: string) => string | null;
};

export function gitReaders(root: string, base: string): ContentReaders {
  return {
    readBase: (path) => (existsAt(root, base, path) ? showFile(root, base, path) : null),
    readWork: (path) => {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Canonical form of one top-level key of a JSON document; absent, `{}` and no file are equal. */
function fragmentState(content: string | null, key: string): string {
  if (content === null) return 'empty';
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return `unparseable:${content.length}:${content}`;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'empty';
  const value = (doc as Record<string, unknown>)[key];
  if (value === undefined || value === null) return 'empty';
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return 'empty';
  }
  return canonical(value);
}

const CHANGE_LABEL: Record<Change['status'], string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
};

/**
 * Hits of a diff on the protected classes:
 * - class 1: an existing file was modified, deleted or renamed (new files are allowed);
 * - class 2 / 3: any change, including new files; `#key` rules compare that JSON key only;
 * - `pnpm-lock.yaml` is exempt when the task type is `deps`.
 */
export function findProtectedHits(
  changes: readonly Change[],
  cfg: ProtectedConfig,
  readers: ContentReaders,
  opts: { taskType?: string | undefined } = {},
): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  const seen = new Set<string>();
  const add = (hit: ProtectedHit): void => {
    const key = `${hit.class}\0${hit.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      hits.push(hit);
    }
  };

  for (const change of changes) {
    const label = CHANGE_LABEL[change.status];
    // Class 1: only the pre-existing side of a change counts.
    const existing =
      change.status === 'M' || change.status === 'D'
        ? change.path
        : change.status === 'R'
          ? change.oldPath
          : undefined;
    if (existing !== undefined) {
      const rule = cfg.class1_add_only.find((g) => matchesCI(existing, splitFragment(g).glob));
      if (rule !== undefined) add({ path: existing, class: 1, rule, change: label });
    }

    // Class 2 and 3: both sides of a rename count.
    const touched = change.oldPath === undefined ? [change.path] : [change.path, change.oldPath];
    for (const path of touched) {
      for (const [cls, key] of CLASS_ORDER) {
        if (cls === 1) continue;
        for (const rule of cfg[key]) {
          const { glob, fragment } = splitFragment(rule);
          if (!matchesCI(path, glob)) continue;
          if (opts.taskType === 'deps' && DEPS_TASK_EXEMPT.has(rule)) continue;
          if (fragment !== null) {
            const before = fragmentState(readers.readBase(path), fragment);
            const after = fragmentState(readers.readWork(path), fragment);
            if (before === after) continue;
            add({ path, class: cls, rule, change: `${label} ("${fragment}" changed)` });
          } else {
            add({ path, class: cls, rule, change: label });
          }
        }
      }
    }
  }
  return hits.sort((a, b) =>
    a.class !== b.class ? a.class - b.class : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
