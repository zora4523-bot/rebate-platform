// Build-time only. Run from the repository root with:
// node apps/api/src/modules/risk/application/scripts/generate-min-version-routes.ts
// Writes ../min-version-routes.gen.ts: every contract operation (planned ones included) with its
// operationId, method, Fastify path template, x-min-version-gate (null when not declared: GET and
// the routes outside /v1), x-session-scopes ([full] when not declared) and x-idempotent, the
// policy table of stage ④a (规划/08 BR-ID-01 细则「最低支持版本的接口层拦截」「受限会话」; 04 §5).
// Read from the same dereferenced contracts/openapi.yaml as platform/http's generators, so no
// openapi is parsed at run time. A /v1 write operation without a gate, a gate on a GET, or an
// unknown gate or scope value stops the generation (a missing gate would leave a route open).
// Rerun after changing the contract; minimum-version.test.ts fails until the file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

export const minVersionRoutesFile = new URL('../min-version-routes.gen.ts', import.meta.url);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const GATES: readonly unknown[] = [true, false, 'conditional'];
const SCOPES: readonly unknown[] = ['full', 'deletion_only'];

export async function minVersionRoutesSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const routes: {
    operationId: string;
    method: string;
    path: string;
    gate: boolean | 'conditional' | null;
    sessionScopes: string[];
    idempotent: boolean;
  }[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string') throw new Error(`${where}: operationId missing`);
      const gate = operation['x-min-version-gate'];
      if (gate !== undefined && !GATES.includes(gate)) {
        throw new Error(`${where}: x-min-version-gate must be true, false or conditional`);
      }
      if (gate !== undefined && method === 'get') {
        throw new Error(`${where}: a GET operation takes no x-min-version-gate`);
      }
      if (gate === undefined && method !== 'get' && path.startsWith('/v1/')) {
        throw new Error(`${where}: a /v1 write operation must declare x-min-version-gate`);
      }
      const scopes = operation['x-session-scopes'] ?? ['full'];
      if (
        !Array.isArray(scopes) ||
        scopes.length === 0 ||
        scopes.some((scope) => !SCOPES.includes(scope))
      ) {
        throw new Error(`${where}: x-session-scopes must list full / deletion_only`);
      }
      routes.push({
        operationId,
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        gate: (gate ?? null) as boolean | 'conditional' | null,
        sessionScopes: scopes as string[],
        idempotent: operation['x-idempotent'] === true,
      });
    }
  }
  return (
    '// Generated from contracts/openapi.yaml by risk/application/scripts/generate-min-version-routes.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n' +
    `export const CONTRACT_MIN_VERSION_ROUTES = ${JSON.stringify(routes, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(minVersionRoutesFile, await minVersionRoutesSource());
}
