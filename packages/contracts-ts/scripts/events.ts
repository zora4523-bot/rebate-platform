// Checks specs/events.yaml, the analytics event table (规划/03 §4.7; 拍板第二批 TECH-21): the
// common fields and individually named events of 03 §4.7 are present, every field has a known
// shape, enum values that mirror contracts/enums match them, route names exist in
// contracts/routes.json, and no field can carry a promotion URL, tpwd, pid or relation_id
// (02 §12.6). Run by codegen.ts in both modes (`pnpm contracts:check`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef } from './catalog.ts';
import { repoRoot, routesFile } from './paths.ts';

export const eventsFile = join(repoRoot, 'specs', 'events.yaml');

type Obj = Record<string, unknown>;

const TYPES = ['string', 'integer', 'boolean', 'enum'];
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
/** An event name, or `<family>.<event>` for a member of a declared family. */
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
/**
 * Name segments (split on `_`) that mark a field able to carry a promotion URL, tpwd or channel
 * identifier (02 §12.6); any field with such a segment is refused, except the exact names in
 * ALLOWED_NAMES whose meaning is known to be harmless.
 */
const FORBIDDEN_SEGMENTS = [
  'url',
  'href',
  'link',
  'deeplink',
  'tpwd',
  'pid',
  'adzone',
  'relation',
  'promo',
];
const FORBIDDEN_JOINED = ['sub_union_id', 'custom_parameters'];
/** Harmless names that contain a forbidden segment: link_id is the server-issued link, pid_scene the scene code. */
const ALLOWED_NAMES = ['link_id', 'pid_scene'];
/** Common fields that 03 §4.7 names. */
const COMMON = [
  'event_id',
  'name',
  'client_at',
  'session_id',
  'device_id',
  'user_id',
  'platform',
  'app_version',
  'channel',
  'page',
  'spm',
  'trace_id',
];
/** Events that 03 §4.7 (and §5.1 for the sampled host event) name individually. */
const REQUIRED_EVENTS = [
  'app_launch',
  'page_view',
  'exposure',
  'click',
  'search',
  'convert',
  'link_jump',
  'sdui_card_error',
  'bridge_call',
  'h5_white_screen',
  'external_page_union_host',
  'external_page_nav_host',
  'external_page_blocked_nav',
  'route_entry_blocked',
  'route_params_dropped',
];
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

function forbidden(name: string): boolean {
  if (ALLOWED_NAMES.includes(name)) return false;
  if (FORBIDDEN_JOINED.some((j) => name.includes(j))) return true;
  return name.split('_').some((segment) => FORBIDDEN_SEGMENTS.includes(segment));
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
    if (!FIELD_NAME.test(name)) problems.push(`${at}: field names are snake_case`);
    if (forbidden(name)) {
      problems.push(`${at}: no field may carry a promotion URL, tpwd or channel id (02 §12.6)`);
    }
    if (!isObj(def)) {
      problems.push(`${at}: must be a mapping`);
      continue;
    }
    for (const k of Object.keys(def)) {
      if (!['type', 'required', 'required_when', 'values', 'note'].includes(k)) {
        problems.push(`${at}: unknown key ${k}`);
      }
    }
    if (!TYPES.includes(String(def['type'])))
      problems.push(`${at}: type must be ${TYPES.join(' / ')}`);
    const when = def['required_when'];
    if ((typeof def['required'] === 'boolean') === (when !== undefined)) {
      problems.push(`${at}: exactly one of required (true / false) and required_when`);
    } else if (when !== undefined) {
      const ok =
        isObj(when) &&
        Object.keys(when).length === 1 &&
        Object.entries(when).every(([f, v]) => {
          const target = fields[f];
          return (
            typeof v === 'string' &&
            isObj(target) &&
            target['type'] === 'enum' &&
            Array.isArray(target['values']) &&
            target['values'].includes(v)
          );
        });
      if (!ok) {
        problems.push(
          `${at}: required_when is {field: value} where field is an enum of the same event and value one of its values`,
        );
      }
    }
    const listed = def['values'];
    if (def['type'] !== 'enum') {
      if (listed !== undefined) problems.push(`${at}: values belong to enum fields only`);
      continue;
    }
    if (!Array.isArray(listed) || listed.length === 0) {
      problems.push(`${at}: an enum lists its values`);
      continue;
    }
    if (listed.some((v) => typeof v !== 'string')) {
      problems.push(`${at}: enum values are strings (quote true, false and numbers)`);
      continue;
    }
    const got = listed as string[];
    if (new Set(got).size !== got.length) problems.push(`${at}: duplicate values`);
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
  for (const f of COMMON) {
    if (!common.includes(f)) problems.push(`${where}: common_fields.${f} is missing (03 §4.7)`);
  }
  const familyDoc = doc['families'];
  if (familyDoc !== undefined && !isObj(familyDoc)) {
    problems.push(`${where}: families must be a mapping`);
  }
  const families = isObj(familyDoc) ? familyDoc : {};
  for (const [name, fam] of Object.entries(families)) {
    if (!FIELD_NAME.test(name)) problems.push(`${where}: families.${name}: names are snake_case`);
    if (!isObj(fam) || typeof fam['description'] !== 'string') {
      problems.push(`${where}: families.${name}: description is required`);
    }
  }
  const events = doc['events'];
  if (!isObj(events)) return [...problems, `${where}: events must be a mapping`];
  for (const e of REQUIRED_EVENTS) {
    if (!(e in events)) problems.push(`${where}: events.${e} is missing (03 §4.7)`);
  }
  // link_jump carries the attempt_id of the open response, required on every purchase step
  // (04 §6.4 POST /v1/events, §8.4; 08 BR-ATTR-21 细则).
  const jump = events['link_jump'];
  const attempt = isObj(jump) && isObj(jump['fields']) ? jump['fields']['attempt_id'] : undefined;
  if (
    !isObj(attempt) ||
    attempt['type'] !== 'string' ||
    !isObj(attempt['required_when']) ||
    attempt['required_when']['phase'] !== 'purchase'
  ) {
    problems.push(
      `${where}: events.link_jump.fields.attempt_id must be a string required when phase is purchase`,
    );
  }
  for (const [name, event] of Object.entries(events)) {
    const at = `${where}: events.${name}`;
    const dot = name.indexOf('.');
    if (!EVENT_NAME.test(name))
      problems.push(`${at}: event names are snake_case or <family>.<event>`);
    else if (dot >= 0 && !(name.slice(0, dot) in families)) {
      problems.push(`${at}: family ${name.slice(0, dot)} is not declared under families`);
    }
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
  return problems;
}
