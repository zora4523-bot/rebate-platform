import { describe, expect, it } from 'vitest';
import { globToRegExp, hasWildcard, matchesAny, splitTopLevelCommas } from './glob.ts';

function matches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

describe('globToRegExp', () => {
  it('matches literal paths exactly', () => {
    expect(matches('turbo.json', 'turbo.json')).toBe(true);
    expect(matches('turbo.json', 'turboxjson')).toBe(false);
    expect(matches('turbo.json', 'apps/turbo.json')).toBe(false);
    expect(matches('a/b.ts', 'a/b.ts.bak')).toBe(false);
  });

  it('lets "**" span zero or more directories', () => {
    expect(matches('tools/**', 'tools/guard/run.ts')).toBe(true);
    expect(matches('tools/**', 'tools/x')).toBe(true);
    expect(matches('tools/**', 'tools')).toBe(false);
    expect(matches('tools/**', 'toolsx/a')).toBe(false);
    expect(matches('**/AGENTS.md', 'AGENTS.md')).toBe(true);
    expect(matches('**/AGENTS.md', 'apps/api/AGENTS.md')).toBe(true);
    expect(matches('**/AGENTS.md', 'apps/api/XAGENTS.md')).toBe(false);
    expect(matches('a/**/z.ts', 'a/z.ts')).toBe(true);
    expect(matches('a/**/z.ts', 'a/b/c/z.ts')).toBe(true);
    expect(matches('a/**/z.ts', 'a/b/c/y.ts')).toBe(false);
    expect(matches('**', 'anything/at/all.txt')).toBe(true);
  });

  it('does not let "*" or "?" cross a slash', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('apps/api/src/modules/*', 'apps/api/src/modules/health')).toBe(true);
    expect(matches('apps/api/src/modules/*', 'apps/api/src/modules/health/index.ts')).toBe(false);
    expect(matches('a?c', 'abc')).toBe(true);
    expect(matches('a?c', 'a/c')).toBe(false);
    expect(matches('**/vitest*.config.*', 'tools/vitest.config.ts')).toBe(true);
    expect(matches('**/vitest*.config.*', 'test/vitest.longrun.config.ts')).toBe(true);
    expect(matches('**/vitest*.config.*', 'vitest.config.mts')).toBe(true);
    expect(matches('**/vitest*.config.*', 'tools/vitest.config/x.ts')).toBe(false);
  });

  it('expands brace groups, including nested ones', () => {
    const glob = 'test/{spec,acceptance,properties,replay}/**';
    expect(matches(glob, 'test/spec/money/round.test.ts')).toBe(true);
    expect(matches(glob, 'test/replay/a.json')).toBe(true);
    expect(matches(glob, 'test/unit/a.test.ts')).toBe(false);
    expect(matches('a/{b,c/{d,e}}/f', 'a/c/e/f')).toBe(true);
    expect(matches('a/{b,c/{d,e}}/f', 'a/c/f')).toBe(false);
    expect(matches('{*.ts,*.js}', 'x.js')).toBe(true);
    expect(matches('pkg/{**/x.ts,y.ts}', 'pkg/a/b/x.ts')).toBe(true);
  });

  it('matches dotfiles with wildcards', () => {
    expect(matches('.claude/**', '.claude/settings.json')).toBe(true);
    expect(matches('tools/**', 'tools/.hidden/file')).toBe(true);
    expect(matches('*', '.npmrc')).toBe(true);
    expect(matches('.githooks/**', '.githooks/pre-commit')).toBe(true);
  });

  it('handles Chinese path segments and regex metacharacters literally', () => {
    expect(matches('规划/**', '规划/08_业务规则/13_命名与编码对照.md')).toBe(true);
    expect(matches('规划/*.md', '规划/02_系统架构.md')).toBe(true);
    expect(matches('规划/*.md', '规划/08_业务规则/README.md')).toBe(false);
    expect(matches('规划/0?_*.md', '规划/02_系统架构.md')).toBe(true);
    expect(matches('docs/a+b (1)/[id].ts', 'docs/a+b (1)/[id].ts')).toBe(true);
    expect(matches('docs/a+b (1)/[id].ts', 'docs/aab (1)/i.ts')).toBe(false);
    expect(matches('**/package.json#scripts', 'package.json#scripts')).toBe(true);
  });

  it('rejects malformed globs', () => {
    expect(() => globToRegExp('')).toThrow(/empty glob/);
    expect(() => globToRegExp('a/{b,c')).toThrow(/unbalanced/);
    expect(() => globToRegExp('a/b}')).toThrow(/unbalanced/);
  });
});

describe('matchesAny', () => {
  it('returns true when any glob matches and false for an empty list', () => {
    expect(matchesAny('packages/money/src/index.ts', ['docs/**', 'packages/money/**'])).toBe(true);
    expect(matchesAny('packages/money/src/index.ts', ['docs/**'])).toBe(false);
    expect(matchesAny('packages/money/src/index.ts', [])).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(matchesAny('Tools/guard/run.ts', ['tools/**'])).toBe(false);
  });

  it('compares NFC-normalised text', () => {
    const decomposed = 'docs/cafe\u0301.md';
    expect(matchesAny(decomposed, ['docs/caf\u00e9.md'])).toBe(true);
  });
});

describe('helpers', () => {
  it('splits on top-level commas only', () => {
    expect(splitTopLevelCommas('a/**,test/{spec,acceptance}/**,b')).toEqual([
      'a/**',
      'test/{spec,acceptance}/**',
      'b',
    ]);
  });

  it('detects wildcards', () => {
    expect(hasWildcard('packages/money/src/index.ts')).toBe(false);
    expect(hasWildcard('packages/money/**')).toBe(true);
    expect(hasWildcard('a/{b,c}')).toBe(true);
    expect(hasWildcard('a/b?.ts')).toBe(true);
  });
});
