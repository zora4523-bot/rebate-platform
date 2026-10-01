import { expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { checkLockfile, lockfileProblems } from './lockfile.ts';

const CLEAN = [
  "lockfileVersion: '9.0'",
  'packages:',
  '  ajv@8.20.0:',
  '    resolution: {integrity: sha512-B+C9Ok0DF/rjANIUHgwcV5/d4C72MB7f2IbKFL8jDGcGq2qn3yr893s8vAn2kbhmyaelAin0JK8EKF9P1+y7aQ==}',
  '  turbo@2.11.3:',
  '    resolution: {integrity: sha512-qehxGkRj55h/ff8EMaJ+cYhyaKlHIxqYDn682wQD7RNp9UujOQsHog2uS0r2vzr4pW+sXf90NeeayjcNaX3fFg==, tarball: https://registry.npmjs.org/turbo/-/turbo-2.11.3.tgz}',
].join('\n');

it('accepts the real lockfile and a clean synthetic one', () => {
  expect(checkLockfile(repoRoot()).problems).toEqual([]);
  expect(lockfileProblems(CLEAN)).toEqual([]);
});

it('reports private registries, query strings, fragments and credentials', () => {
  const bad = [
    CLEAN,
    '  secret@1.0.0:',
    '    resolution: {integrity: sha512-aaaa, tarball: https://npm.example.com/secret/-/secret-1.0.0.tgz}',
    '  tokened@1.0.0:',
    '    resolution: {integrity: sha512-bbbb, tarball: https://registry.npmjs.org/tokened/-/tokened-1.0.0.tgz?token=abc}',
    '  cred@1.0.0:',
    '    resolution: {tarball: https://user:pw@registry.npmjs.org/cred/-/cred-1.0.0.tgz}',
    '  git@1.0.0:',
    '    resolution: {type: git, repo: git+ssh://git@github.com/o/r.git, commit: abc}',
  ].join('\n');
  const problems = lockfileProblems(bad);
  expect(problems.some((p) => p.includes('outside') && p.includes('npm.example.com'))).toBe(true);
  expect(problems.some((p) => p.includes('query string') && p.includes('token=abc'))).toBe(true);
  expect(problems.some((p) => p.includes('outside') && p.includes('user:pw@'))).toBe(true);
  expect(problems.some((p) => p.includes('outside') && p.includes('git+ssh'))).toBe(true);
  expect(problems).toHaveLength(4);
});
