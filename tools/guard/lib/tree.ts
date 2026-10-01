// Lists the files of a source tree for the static guards.
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../lib/git.ts';

// Used only when there is no `.git` (verify container): mirrors the repository's .gitignore.
const WALK_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  '.tmp',
  '.turbo',
  'coverage',
  'reports',
]);

export type TreeListing = { files: string[]; mode: 'git' | 'walk' };

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!WALK_SKIP.has(entry.name)) walk(root, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Tracked and untracked-but-not-ignored regular files (`git ls-files -co --exclude-standard`),
 * as sorted repo-relative POSIX paths. Without a `.git` entry the directory is walked instead.
 * Symbolic links are not followed and not listed.
 */
export function listTreeFiles(root: string): TreeListing {
  if (existsSync(join(root, '.git'))) {
    const out = git(['-c', 'core.quotepath=false', 'ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: root,
    });
    const files = [...new Set(out.split('\0').filter((p) => p !== ''))].filter((p) => {
      try {
        return lstatSync(join(root, p)).isFile();
      } catch {
        return false;
      }
    });
    return { files: files.sort(), mode: 'git' };
  }
  const files: string[] = [];
  walk(root, '', files);
  return { files: files.sort(), mode: 'walk' };
}
