// Lockfile hygiene (规划/11 §8 公开仓库泄密; ADR-0001 §2 依赖策略).
//
// gitleaks' default configuration excludes pnpm-lock.yaml from every rule (verified with
// gitleaks 8.30.1: a token inside the lockfile is reported in any other file name, never in
// pnpm-lock.yaml, with or without our own allowlist). A dependency resolved from a private
// registry, a tarball URL with a query string, or a URL carrying credentials would therefore
// enter the public repository unnoticed. This check reads every URL in the lockfile and
// accepts only https://registry.npmjs.org/… without query, fragment or credentials.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_REGISTRY = 'https://registry.npmjs.org/';

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)}\],]+/gi;

/** Problems found in the lockfile text; empty when every URL is a clean npm registry URL. */
export function lockfileProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(URL_PATTERN)) {
      const url = match[0];
      const where = `line ${index + 1}`;
      if (!url.startsWith(ALLOWED_REGISTRY)) {
        problems.push(`${where}: URL outside ${ALLOWED_REGISTRY}: ${url}`);
        continue;
      }
      if (/[?#]/.test(url))
        problems.push(`${where}: URL carries a query string or fragment: ${url}`);
      if (/^[a-z]+:\/\/[^/]*@/i.test(url))
        problems.push(`${where}: URL carries credentials: ${url}`);
    }
    if (/^\s*tarball:/.test(line) && !URL_PATTERN.test(line)) {
      problems.push(`line ${index + 1}: tarball entry without a parseable URL`);
    }
    URL_PATTERN.lastIndex = 0;
  });
  return problems;
}

export function checkLockfile(root: string): { problems: string[]; notices: string[] } {
  const file = join(root, 'pnpm-lock.yaml');
  if (!existsSync(file)) return { problems: [], notices: ['no pnpm-lock.yaml at the root'] };
  return { problems: lockfileProblems(readFileSync(file, 'utf8')), notices: [] };
}
