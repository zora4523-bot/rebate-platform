// Checks specs/events.yaml, the analytics event table (规划/03 §4.7; 拍板第二批 TECH-21): the
// shape of every field, enum values that mirror contracts/enums, route names that exist in
// contracts/routes.json, and that no field can carry a promotion URL, tpwd, pid or relation_id
// (02 §12.6). Run by codegen.ts in both modes (`pnpm contracts:check`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef } from './catalog.ts';
import { repoRoot, routesFile } from './paths.ts';

export const eventsFile = join(repoRoot, 'specs', 'events.yaml');

type Obj = Record<string, unknown>;

const TYPES = ['string', 'integer', 'boolean', 'enum'];
const NAME = /^[a-z][a-z0-9_]*$/;
/** Field names that would carry a promotion URL, tpwd or channel identifiers (02 §12.6). */
const FORBIDDEN = /(^|_)(url|tpwd|pid|relation_id|sub_union_id|custom_parameters|promo_link)($|_)/;
/** Field name → enum of contracts/enums it must equal (or be a subset of, for platform). */
const EXACT: Readonly<Record<string, string>> = {
  union_platform: 'platform',
  installed: 'installed_state',
  category: 'link_pattern_category',
};
const SUBSET: Readonly<Record<string, string>> = { platform: 'client_platform' };

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkFields(
  fields: unknown,
  where: string,
  enums: readonly EnumDef[],
  routes: readonly string[],
  problems: string[],
): void {
  if (!isObj(fields)) {
    problems.push(`${where}: fields must be a mapping`);
    return;
  }
  const values = (name: string): string[] =>
    enums.find((e) => e.name === name)?.values.map((v) => String(v.value)) ?? [];
  for (const [name, def] of Object.entries(fields)) {
    const at = `${where}.${name}`;
    if (!NAME.test(name)) problems.push(`${at}: field names are snake_case`);
    if (FORBIDDEN.test(name)) {
      problems.push(`${at}: no field may carry a promotion URL, tpwd or channel id (02 §12.6)`);
    }
    if (!isObj(def)) {
      problems.push(`${at}: must be a mapping`);
      continue;
    }
    for (const k of Object.keys(def)) {
      if (!['type', 'required', 'values', 'note'].includes(k))
        problems.push(`${at}: unknown key ${k}`);
    }
    if (!TYPES.includes(String(def['type'])))
      problems.push(`${at}: type must be ${TYPES.join(' / ')}`);
    if (typeof def['required'] !== 'boolean')
      problems.push(`${at}: required must be true or false`);
    const listed = def['values'];
    if (def['type'] === 'enum') {
      if (!Array.isArray(listed) || listed.length === 0) {
        problems.push(`${at}: an enum lists its values`);
        continue;
      }
      const got = listed.map(String);
      const exact = EXACT[name];
      const subset = SUBSET[name];
      if (exact !== undefined) {
        const want = values(exact);
        if (got.length !== want.length || want.some((v) => !got.includes(v))) {
          problems.push(`${at}: values must equal contracts/enums ${exact}`);
        }
      } else if (subset !== undefined && got.some((v) => !values(subset).includes(v))) {
        problems.push(`${at}: values must be a subset of contracts/enums ${subset}`);
      }
      if (name === 'route' && got.some((v) => !routes.includes(v))) {
        problems.push(`${at}: every route must exist in contracts/routes.json`);
      }
    } else if (listed !== undefined) {
      problems.push(`${at}: values belong to enum fields only`);
    }
  }
}

export function checkEvents(enums: readonly EnumDef[], file: string = eventsFile): string[] {
  const where = 'specs/events.yaml';
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYamlLite(readFileSync(file, 'utf8'));
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!isObj(doc)) return [`${where}: top level must be a mapping`];
  const routesDoc: unknown = JSON.parse(readFileSync(routesFile, 'utf8'));
  const routes =
    isObj(routesDoc) && isObj(routesDoc['routes']) ? Object.keys(routesDoc['routes']) : [];
  for (const k of Object.keys(doc)) {
    if (!['version', 'common_fields', 'events', 'families'].includes(k)) {
      problems.push(`${where}: unknown top-level key ${k}`);
    }
  }
  if (typeof doc['version'] !== 'string' || doc['version'] === '') {
    problems.push(`${where}: version must be a non-empty string`);
  }
  checkFields(doc['common_fields'], `${where}: common_fields`, enums, routes, problems);
  const common = isObj(doc['common_fields']) ? Object.keys(doc['common_fields']) : [];
  const events = doc['events'];
  if (!isObj(events)) return [...problems, `${where}: events must be a mapping`];
  for (const [name, event] of Object.entries(events)) {
    const at = `${where}: events.${name}`;
    if (!NAME.test(name)) problems.push(`${at}: event names are snake_case`);
    if (!isObj(event)) {
      problems.push(`${at}: must be a mapping`);
      continue;
    }
    for (const k of Object.keys(event)) {
      if (!['description', 'source', 'fields'].includes(k))
        problems.push(`${at}: unknown key ${k}`);
    }
    if (typeof event['description'] !== 'string' || typeof event['source'] !== 'string') {
      problems.push(`${at}: description and source are required strings`);
    }
    checkFields(event['fields'], `${at}.fields`, enums, routes, problems);
    if (isObj(event['fields'])) {
      for (const f of Object.keys(event['fields'])) {
        if (common.includes(f)) problems.push(`${at}.fields.${f}: shadows a common field`);
      }
    }
  }
  const families = doc['families'];
  if (families !== undefined) {
    if (!isObj(families)) problems.push(`${where}: families must be a mapping`);
    else {
      for (const [name, fam] of Object.entries(families)) {
        if (!NAME.test(name)) problems.push(`${where}: families.${name}: names are snake_case`);
        if (!isObj(fam) || typeof fam['description'] !== 'string') {
          problems.push(`${where}: families.${name}: description is required`);
        }
      }
    }
  }
  return problems;
}
