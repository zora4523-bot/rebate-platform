// SPEC_REF must be a commit on the planning repository's main branch (规划/11 §5.3).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from '../../lib/git.ts';
import { result, skipped } from './cli.ts';
import type { CheckResult } from './cli.ts';

const NAME = 'spec-ref';

/**
 * - `<root>/SPEC_REF` is one line holding a 40-character lower-case commit id.
 * - `git -C <specRepo> merge-base --is-ancestor <SPEC_REF> origin/main` succeeds.
 * When the planning repository is not available the ancestry check is skipped (or fails when
 * `requireSpecRepo` is set); the format check always runs.
 */
export function checkSpecRef(
  root: string,
  specRepoDir: string,
  opts: { requireSpecRepo: boolean },
): CheckResult {
  const file = join(root, 'SPEC_REF');
  if (!existsSync(file)) return result(NAME, ['SPEC_REF is missing']);
  const text = readFileSync(file, 'utf8');
  const ref = text.trim();
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    return result(NAME, ['SPEC_REF must be a 40-character lower-case hexadecimal commit id']);
  }
  if (text !== ref && text !== `${ref}\n`) {
    return result(NAME, ['SPEC_REF must contain exactly one line']);
  }
  if (!existsSync(specRepoDir)) {
    const notice = `planning repository not found at ${specRepoDir}; ancestry of ${ref} not checked`;
    return opts.requireSpecRepo ? result(NAME, [notice]) : skipped(NAME, notice);
  }
  const res = tryGit(['-C', specRepoDir, 'merge-base', '--is-ancestor', ref, 'origin/main']);
  if (res.status === 0) return result(NAME, []);
  if (res.status === 1) {
    return result(NAME, [`${ref} is not an ancestor of origin/main in ${specRepoDir}`]);
  }
  return result(NAME, [
    `cannot verify ${ref} against origin/main in ${specRepoDir}: ${res.stderr.trim()}`,
  ]);
}
