// Risk level by path (规划/11 §1.2): default RV2, first match wins, whitelist in ops/risk-map.yaml.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp, hasWildcard, matchesAny } from '../../lib/glob.ts';
import { parseYamlLite } from '../../lib/yaml-lite.ts';
import { classOfPath, covers } from './protected.ts';
import type { ProtectedClass, ProtectedConfig } from './protected.ts';

export type RiskLevel = 'RV0' | 'RV1' | 'RV2';

export type RiskRule = {
  path: string;
  risk: RiskLevel;
  impl: 'codex' | 'claude';
  tester: 'codex' | 'claude' | 'none';
  review: string;
};

export type RiskMap = { version: 1; rules: RiskRule[] };

export type PathRisk = {
  path: string;
  risk: RiskLevel;
  rule: string;
  protected: ProtectedClass | null;
};

export type RiskReport = { risk: RiskLevel; ask: boolean; paths: PathRisk[] };

const LEVELS: readonly RiskLevel[] = ['RV0', 'RV1', 'RV2'];
const REVIEWS = new Set(['claude', 'codex', 'claude+codex']);
const RULE_KEYS = new Set(['path', 'risk', 'impl', 'tester', 'review']);

function rank(level: RiskLevel): number {
  return LEVELS.indexOf(level);
}

export function parseRiskMap(text: string): RiskMap {
  const doc = parseYamlLite(text);
  const problems: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('risk-map.yaml: the document must be a mapping');
  }
  const top = doc as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'version' && key !== 'rules') problems.push(`${key}: unknown key`);
  }
  if (top['version'] !== 1) problems.push('version: must be 1');
  const rules: RiskRule[] = [];
  const rawRules = top['rules'];
  if (!Array.isArray(rawRules)) {
    problems.push('rules: must be a list');
  } else {
    const seen = new Set<string>();
    rawRules.forEach((raw, index) => {
      const at = `rules[${index}]`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        problems.push(`${at}: must be a mapping`);
        return;
      }
      const rule = raw as Record<string, unknown>;
      const before = problems.length;
      for (const key of Object.keys(rule)) {
        if (!RULE_KEYS.has(key)) problems.push(`${at}.${key}: unknown key`);
      }
      const path = rule['path'];
      if (typeof path !== 'string' || path === '') {
        problems.push(`${at}.path: must be a non-empty glob`);
      } else {
        try {
          globToRegExp(path);
        } catch (err) {
          problems.push(`${at}.path: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (seen.has(path)) problems.push(`${at}.path: duplicate rule for "${path}"`);
        seen.add(path);
      }
      if (!(LEVELS as readonly unknown[]).includes(rule['risk'])) {
        problems.push(`${at}.risk: must be RV0, RV1 or RV2`);
      }
      if (rule['impl'] !== 'codex' && rule['impl'] !== 'claude') {
        problems.push(`${at}.impl: must be codex or claude`);
      }
      if (rule['tester'] !== 'codex' && rule['tester'] !== 'claude' && rule['tester'] !== 'none') {
        problems.push(`${at}.tester: must be codex, claude or none`);
      }
      if (typeof rule['review'] !== 'string' || !REVIEWS.has(rule['review'])) {
        problems.push(`${at}.review: must be claude, codex or claude+codex`);
      }
      if (problems.length === before) rules.push(rule as unknown as RiskRule);
    });
  }
  if (problems.length > 0) {
    throw new Error(`risk-map.yaml: invalid\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return { version: 1, rules };
}

export function loadRiskMap(root: string): RiskMap {
  return parseRiskMap(readFileSync(join(root, 'ops', 'risk-map.yaml'), 'utf8'));
}

function literalPrefix(glob: string): string {
  const m = /[*?{]/.exec(glob);
  return m ? glob.slice(0, m.index) : glob;
}

function mayOverlap(rule: string, input: string): boolean {
  const a = literalPrefix(rule);
  const b = literalPrefix(input);
  return a.startsWith(b) || b.startsWith(a);
}

function normalise(input: string): string {
  let p = input.normalize('NFC');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * Risk of one literal path (changed file) or one task glob.
 * - Literal path: the first matching rule wins; no match means RV2.
 * - Glob: the glob must lie entirely inside one rule to leave the default, and it takes the
 *   highest risk among all rules it may overlap, so a wide glob never lowers the level.
 */
export function riskOfPath(input: string, map: RiskMap, cfg: ProtectedConfig): PathRisk {
  const path = normalise(input);
  const fallback: PathRisk = { path, risk: 'RV2', rule: 'default', protected: null };
  if (path === '' || path.startsWith('/') || path.split('/').includes('..')) return fallback;
  const prot = classOfPath(path, cfg);

  if (!hasWildcard(path)) {
    const rule = map.rules.find((r) => matchesAny(path, [r.path]));
    return rule
      ? { path, risk: rule.risk, rule: rule.path, protected: prot }
      : { ...fallback, protected: prot };
  }

  const covering = map.rules.find((r) => covers(r.path, path));
  if (!covering) return { ...fallback, protected: prot };
  let chosen = covering;
  for (const rule of map.rules) {
    if (mayOverlap(rule.path, path) && rank(rule.risk) > rank(chosen.risk)) chosen = rule;
  }
  return { path, risk: chosen.risk, rule: chosen.path, protected: prot };
}

/** Highest risk over the paths; an empty list is RV2 (the default is the strictest level). */
export function riskOfPaths(
  inputs: readonly string[],
  map: RiskMap,
  cfg: ProtectedConfig,
): RiskReport {
  const paths = inputs.map((p) => riskOfPath(p, map, cfg));
  let risk: RiskLevel = paths.length === 0 ? 'RV2' : 'RV0';
  for (const p of paths) if (rank(p.risk) > rank(risk)) risk = p.risk;
  return { risk, ask: paths.some((p) => p.protected === 2 || p.protected === 3), paths };
}
