// Every module and package directory must appear in ops/risk-map.yaml (规划/11 §1.2).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RiskMap } from './risk.ts';

export const COVERED_PARENTS = ['apps/api/src/modules', 'packages'] as const;

/**
 * A directory is covered only by a rule that names it literally (`<dir>/...`); a wide rule
 * such as `packages/**` does not count, so a new module cannot slip in under an old level.
 */
export function checkCoverage(
  root: string,
  map: RiskMap,
): { problems: string[]; notices: string[] } {
  const problems: string[] = [];
  const notices: string[] = [];
  for (const parent of COVERED_PARENTS) {
    const dir = join(root, parent);
    if (!existsSync(dir)) {
      notices.push(`${parent}: directory does not exist yet`);
      continue;
    }
    const children = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
    for (const child of children) {
      const prefix = `${parent}/${child}/`;
      if (!map.rules.some((rule) => rule.path.startsWith(prefix))) {
        problems.push(`${parent}/${child}: no explicit rule in ops/risk-map.yaml`);
      }
    }
  }
  return { problems, notices };
}
