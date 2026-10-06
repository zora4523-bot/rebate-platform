// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/validation/scripts/generate-signing-routes.ts
// Writes ../signing-routes.gen.ts: method + Fastify path template → x-signed of EVERY contract
// operation, planned ones included (the risk module's request signature check, BR-ID-09; 04 §5
// 签名). Read from the same dereferenced contracts/openapi.yaml as ./generate-route-schemas.ts, so
// no openapi is parsed at run time. A missing x-signed is false; any value other than a boolean
// stops the generation. Rerun after changing the contract; signing-routes.test.ts fails until the
// generated file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

export const signingRoutesFile = new URL('../signing-routes.gen.ts', import.meta.url);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export async function signingRoutesSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const routes: { method: string; path: string; signed: boolean }[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      const signed = operation['x-signed'] ?? false;
      if (typeof signed !== 'boolean') {
        throw new Error(`${method.toUpperCase()} ${path}: x-signed must be a boolean`);
      }
      routes.push({
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        signed,
      });
    }
  }
  return (
    '// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-signing-routes.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n' +
    `export const CONTRACT_SIGNING_ROUTES = ${JSON.stringify(routes, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(signingRoutesFile, await signingRoutesSource());
}
