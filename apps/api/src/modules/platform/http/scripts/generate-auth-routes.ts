// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/http/scripts/generate-auth-routes.ts
// Writes ../auth-routes.gen.ts: method + Fastify path template → x-auth of EVERY contract
// operation, planned ones included (the token stages ② ③ of identity, 规划/08 BR-ID-01; 04 §5
// 鉴权级别). Read from the same dereferenced contracts/openapi.yaml as the route schema and
// signing table generators (platform/validation/scripts), so no openapi is parsed at run time.
// Every operation must declare x-auth as one of the five app levels none / optional / login /
// phone / realname (04 §5) or the two admin levels admin / super (enum admin_auth_level in the
// contract's info.description; /admin/v1 operations, whose none is the same value); any other
// value, or none at all, stops the generation (a missing level would leave a route open).
// Rerun after changing the contract; auth-routes.test.ts fails until the generated file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

export const authRoutesFile = new URL('../auth-routes.gen.ts', import.meta.url);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const LEVELS: readonly unknown[] = [
  // App levels (04 §5).
  'none',
  'optional',
  'login',
  'phone',
  'realname',
  // Admin levels (contract info.description, admin_auth_level: none | admin | super).
  'admin',
  'super',
];

export async function authRoutesSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const routes: { method: string; path: string; auth: string }[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      const auth = operation['x-auth'];
      if (!LEVELS.includes(auth)) {
        throw new Error(
          `${method.toUpperCase()} ${path}: x-auth must be one of ${LEVELS.join(', ')}`,
        );
      }
      routes.push({
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        auth: auth as string,
      });
    }
  }
  return (
    '// Generated from contracts/openapi.yaml by platform/http/scripts/generate-auth-routes.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n' +
    `export const CONTRACT_AUTH_ROUTES = ${JSON.stringify(routes, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(authRoutesFile, await authRoutesSource());
}
