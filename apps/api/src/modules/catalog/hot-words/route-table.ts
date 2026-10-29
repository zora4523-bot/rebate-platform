// B1-05m: contracts/routes.json (CT-03) as the keyword shortcut save check reads it, read once per
// process and each route's params schema compiled with Ajv2020 (strict, allErrors, no coercion),
// the way content's infra/home-schema.ts reads contracts/home-schema.json. The generated bridge
// table (packages/contracts-ts bridge.gen.ts) keeps route names only, not their params schemas,
// so the file itself is the single source; no route list is copied here.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const ROUTES_FILE = new URL('../../../../../../contracts/routes.json', import.meta.url);

export interface RouteTable {
  /**
   * Whether `params` (absent = no params) opens `route`: the route is in the table and not
   * debug_only (release builds drop those, TECH-11), and params pass its schema.
   */
  fits(route: string, params: Readonly<Record<string, unknown>> | undefined): boolean;
}

type Json = Record<string, unknown>;

export function compileRouteTable(document: unknown): RouteTable {
  const routes = (document as Json | null)?.['routes'];
  if (typeof routes !== 'object' || routes === null || Array.isArray(routes)) {
    throw new Error('contracts/routes.json: routes required');
  }
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validators = new Map<string, ReturnType<Ajv2020['compile']>>();
  for (const [name, entry] of Object.entries(routes as Record<string, Json>)) {
    if (entry['debug_only'] === true) continue;
    const params = entry['params'];
    if (typeof params !== 'object' || params === null) {
      throw new Error(`contracts/routes.json: ${name}.params required`);
    }
    validators.set(name, ajv.compile(params));
  }
  return {
    fits(route, params) {
      const validate = validators.get(route);
      return validate !== undefined && validate(params ?? {}) === true;
    },
  };
}

let loaded: RouteTable | undefined;

/** The process-wide table of contracts/routes.json. */
export function routeTable(): RouteTable {
  loaded ??= compileRouteTable(JSON.parse(readFileSync(ROUTES_FILE, 'utf8')) as unknown);
  return loaded;
}
