// F1-09f: contracts/home-schema.json (CT-07a), read once per process and compiled with Ajv2020
// (strict, allErrors; int32 / int64 formats as platform's request validation defines them). Only
// the page's `sections` array is checked, wrapped as { sections } so error paths start at
// `sections` (the console saves and publishes sections, not a delivered page).
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { ShapeIssue } from '../domain/pages/admin-sections.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const HOME_SCHEMA_FILE = new URL(
  '../../../../../../contracts/home-schema.json',
  import.meta.url,
);

type Json = Record<string, unknown>;

export interface HomeSectionsSchema {
  /** Ajv errors of `sections`; [] when the shape is valid. */
  issues(sections: unknown): readonly ShapeIssue[];
  /** Section types the schema validates by type (the registered cards, 03 §6.3). */
  readonly registeredTypes: ReadonlySet<string>;
}

function registeredTypesOf(section: Json): Set<string> {
  const types = new Set<string>();
  const branches = Array.isArray(section['allOf']) ? (section['allOf'] as Json[]) : [];
  for (const branch of branches) {
    const type = (
      (branch['if'] as Json | undefined)?.['properties'] as Record<string, Json> | undefined
    )?.['type'];
    const values = type?.['enum'];
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === 'string') types.add(value);
    }
  }
  if (types.size === 0) throw new Error('contracts/home-schema.json: no registered section type');
  return types;
}

export function compileHomeSectionsSchema(document: unknown): HomeSectionsSchema {
  const root = document as Json;
  const properties = root['properties'] as Json | undefined;
  const defs = root['$defs'] as Record<string, Json> | undefined;
  const sections = properties?.['sections'];
  const section = defs?.['section'];
  if (typeof sections !== 'object' || sections === null || section === undefined) {
    throw new Error('contracts/home-schema.json: properties.sections and $defs.section required');
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  const validate = ajv.compile({
    ...(typeof root['$schema'] === 'string' ? { $schema: root['$schema'] } : {}),
    type: 'object',
    properties: { sections },
    $defs: defs,
  });
  return {
    issues(value) {
      if (validate({ sections: value })) return [];
      return (validate.errors ?? []).map((error) => ({
        keyword: error.keyword,
        instancePath: error.instancePath,
        params: error.params as Record<string, unknown>,
      }));
    },
    registeredTypes: registeredTypesOf(section),
  };
}

let loaded: HomeSectionsSchema | undefined;

/** The compiled contract, loaded on first use and shared by the process. */
export function homeSectionsSchema(): HomeSectionsSchema {
  loaded ??= compileHomeSectionsSchema(
    JSON.parse(readFileSync(HOME_SCHEMA_FILE, 'utf8')) as unknown,
  );
  return loaded;
}
