// Test support for the guards: throwaway file trees and git repositories.
// Git fixtures live under REPO/.tmp (git-ignored), never under the system temp directory:
// that directory is a writable root of the Codex sandbox (规划/11 §0). Plain file trees may
// use the system temp directory.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from '../../lib/paths.ts';

const created: string[] = [];

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A plain directory tree in the system temp directory. */
export function makeTree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'couli-guard-'));
  created.push(root);
  writeFiles(root, files);
  return root;
}

/** Runs git inside a fixture repository with a fixed identity and hooks disabled. */
export function fixtureGit(repo: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' },
  ).trim();
}

/** A git repository under REPO/.tmp with one commit containing `files`; returns root and commit. */
export function makeRepo(files: Record<string, string>): { root: string; base: string } {
  const parent = join(repoRoot(), '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'guard-fixture-'));
  created.push(root);
  fixtureGit(root, ['init', '-q', '-b', 'main']);
  writeFiles(root, files);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return { root, base: fixtureGit(root, ['rev-parse', 'HEAD']) };
}

/** Removes everything created through this module (call from afterAll / afterEach). */
export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
