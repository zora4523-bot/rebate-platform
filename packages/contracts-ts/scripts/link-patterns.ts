// Checks specs/link-patterns.yaml, the platform link pattern table (规划/08 BR-ATTR-29 细则
// 「平台链接形态表」; source of /v1/config.link_patterns, 04 §10.1). Run by codegen.ts in both
// modes, so `pnpm contracts:check` fails on a violation. The syntax is documented in the file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef } from './catalog.ts';
import { repoRoot } from './paths.ts';

export const linkPatternsFile = join(repoRoot, 'specs', 'link-patterns.yaml');
export const navigationVectorsFile = join(repoRoot, 'specs', 'external-navigation.vectors.json');

type Obj = Record<string, unknown>;

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const KEYS = ['platform', 'category', 'hosts', 'path_patterns'];

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A lower-case dotted domain name that a URL parser keeps as it is: no single label, no IPv4 in
 * any notation (0x7f.1, 127.1 …) and no IPv6.
 */
function isDomainName(h: string): boolean {
  if (!HOST.test(h) || !h.includes('.')) return false;
  let parsed: string;
  try {
    parsed = new URL(`https://${h}/`).hostname;
  } catch {
    return false;
  }
  return parsed === h && !/^[0-9.]+$/.test(parsed) && !/^[0-9]+$/.test(h.split('.').at(-1) ?? '');
}

function covers(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Checks specs/link-patterns.yaml and the synthetic rule tables of
 * specs/external-navigation.vectors.json against the same structure rules.
 */
export function checkLinkPatterns(
  enums: readonly EnumDef[],
  file: string = linkPatternsFile,
  vectorsFile: string | null = navigationVectorsFile,
): string[] {
  const where = 'specs/link-patterns.yaml';
  let doc: unknown;
  try {
    doc = parseYamlLite(readFileSync(file, 'utf8'));
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
  }
  const problems = checkTable(doc, enums, where);
  if (vectorsFile !== null) {
    const vwhere = 'specs/external-navigation.vectors.json';
    try {
      const vectors: unknown = JSON.parse(readFileSync(vectorsFile, 'utf8'));
      const tables = isObj(vectors) && isObj(vectors['rule_tables']) ? vectors['rule_tables'] : {};
      if (Object.keys(tables).length === 0) problems.push(`${vwhere}: rule_tables missing`);
      for (const [name, table] of Object.entries(tables)) {
        problems.push(...checkTable(table, enums, `${vwhere}: rule_tables.${name}`));
      }
    } catch (err) {
      problems.push(`${vwhere}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

function checkTable(doc: unknown, enums: readonly EnumDef[], where: string): string[] {
  const problems: string[] = [];
  if (!isObj(doc)) return [`${where}: top level must be a mapping`];
  const extra = Object.keys(doc).filter((k) => k !== 'version' && k !== 'rules');
  if (extra.length > 0) problems.push(`${where}: unknown top-level keys ${extra.join(', ')}`);
  if (typeof doc['version'] !== 'string' || doc['version'] === '') {
    problems.push(`${where}: version must be a non-empty string`);
  }
  const rules = doc['rules'];
  if (!Array.isArray(rules)) return [...problems, `${where}: rules must be a list`];
  const values = (name: string): unknown[] =>
    enums.find((e) => e.name === name)?.values.map((v) => v.value) ?? [];
  const platforms = values('platform');
  const categories = values('link_pattern_category');
  const unionHosts = new Map<string, string[]>();
  rules.forEach((rule, i) => {
    const at = `${where}: rules[${String(i)}]`;
    if (!isObj(rule)) {
      problems.push(`${at}: must be a mapping`);
      return;
    }
    for (const k of Object.keys(rule))
      if (!KEYS.includes(k)) problems.push(`${at}: unknown key ${k}`);
    const { platform, category, hosts, path_patterns: patterns } = rule;
    if (!platforms.includes(platform))
      problems.push(`${at}: platform must be one of enum platform`);
    if (!categories.includes(category)) {
      problems.push(`${at}: category must be one of enum link_pattern_category`);
    }
    if (!Array.isArray(hosts) || hosts.length === 0) {
      problems.push(`${at}: hosts must be a non-empty list`);
    } else {
      for (const h of hosts) {
        if (typeof h !== 'string' || !isDomainName(h)) {
          problems.push(
            `${at}: host ${JSON.stringify(h)} is not a lower-case domain name with a dot (no IP)`,
          );
        }
      }
      const seen = hosts.filter((h, j) => hosts.indexOf(h) !== j);
      if (seen.length > 0) problems.push(`${at}: duplicate hosts ${seen.join(', ')}`);
      if (category === 'union_host' && typeof platform === 'string') {
        unionHosts.set(platform, [...(unionHosts.get(platform) ?? []), ...hosts.map(String)]);
      }
    }
    if (!Array.isArray(patterns)) {
      problems.push(`${at}: path_patterns must be a list`);
    } else if (category === 'union_host' && patterns.length > 0) {
      problems.push(`${at}: union_host matches whole domains, path_patterns must be empty`);
    } else if (category !== 'union_host' && patterns.length === 0) {
      problems.push(`${at}: ${String(category)} needs at least one path pattern`);
    } else {
      for (const p of patterns) {
        if (typeof p !== 'string' || !p.startsWith('/') || /[?#%\s]/.test(p)) {
          problems.push(
            `${at}: path pattern ${JSON.stringify(p)} must start with / and hold no ?, #, % or space`,
          );
        }
      }
    }
  });
  rules.forEach((rule, i) => {
    if (!isObj(rule) || rule['category'] !== 'product' || !Array.isArray(rule['hosts'])) return;
    const domains = unionHosts.get(String(rule['platform'])) ?? [];
    for (const h of rule['hosts']) {
      if (typeof h === 'string' && !domains.some((d) => covers(d, h))) {
        problems.push(
          `${where}: rules[${String(i)}]: product host ${h} is not inside a union_host domain ` +
            `of the same platform (BR-ATTR-29 ②(a))`,
        );
      }
    }
  });
  return problems;
}
