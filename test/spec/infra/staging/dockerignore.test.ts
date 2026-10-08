import { expect, it } from 'vitest';
import { asset } from './kit.ts';

// Conservative static check of literal directory / ** exclusion rules. No Docker build.
// Do not silently accept a later ! pattern that restores a credential or local dependency.
it.each(['.env', '.git', 'node_modules', 'couli-runs'])(
  '[AC-B1-01zc-CONTEXT#1] 构建上下文排除 %s，且没有重新纳入规则',
  (name) => {
    const patterns = asset('.dockerignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    const positive = patterns.filter((line) => !line.startsWith('!'));
    const normalized = positive.map((line) => line.replace(/^\//, '').replace(/\/$/, ''));
    const exact = [name, `**/${name}`, `${name}/**`, `**/${name}/**`];
    if (name === '.env') exact.push('.env*', '**/.env*');
    expect(normalized.some((line) => exact.includes(line))).toBe(true);
    if (name === '.env') {
      expect(
        normalized.some((line) => ['.env*', '.env.*', '**/.env*', '**/.env.*'].includes(line)),
      ).toBe(true);
      expect(normalized.some((line) => ['**/.env', '**/.env*'].includes(line))).toBe(true);
      expect(normalized.some((line) => ['**/.env*', '**/.env.*'].includes(line))).toBe(true);
    }
    if (name === 'node_modules') {
      expect(
        normalized.some((line) => ['**/node_modules', '**/node_modules/**'].includes(line)),
      ).toBe(true);
    }
    // An explicitly public example file is the only permitted re-inclusion.
    expect(
      patterns.filter((line) => line.startsWith('!') && !/^!(?:\*\*\/)?\.env\.example$/.test(line)),
    ).toEqual([]);
  },
);
