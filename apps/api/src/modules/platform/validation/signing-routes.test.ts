import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { expect, it } from 'vitest';
import { signingRoutesFile, signingRoutesSource } from './scripts/generate-signing-routes.ts';
import { contractSigningRoutes, isContractSignedRoute } from './signing-routes.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

it('[BR-ID-09] the generated signing table matches the current contract', async () => {
  expect(
    await readFile(signingRoutesFile, 'utf8'),
    'signing-routes.gen.ts drifted from contracts/openapi.yaml: regenerate it from the repository ' +
      'root with `node apps/api/src/modules/platform/validation/scripts/generate-signing-routes.ts`',
  ).toBe(await signingRoutesSource());
});

it('[BR-ID-09] lists every contract operation once, planned ones included, x-signed missing = false', async () => {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const expected: { method: string; path: string; signed: boolean }[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item?.[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      expected.push({
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        signed: operation['x-signed'] === true,
      });
    }
  }
  const routes = contractSigningRoutes();
  expect([...routes]).toEqual(expected);
  expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);
  expect(routes.some((route) => route.signed)).toBe(true);
  expect(Object.isFrozen(routes)).toBe(true);
  for (const route of routes) {
    expect(isContractSignedRoute(route.method, route.path)).toBe(route.signed);
    expect(isContractSignedRoute(route.method.toLowerCase(), route.path)).toBe(route.signed);
  }
});

it('[BR-ID-09] an unmatched or undeclared route is not signed; HEAD follows its GET operation', () => {
  const signed = contractSigningRoutes().find((route) => route.signed);
  expect(signed).toBeDefined();
  expect(isContractSignedRoute(signed!.method, undefined)).toBe(false);
  expect(isContractSignedRoute(signed!.method, `${signed!.path}/unmatched`)).toBe(false);
  expect(isContractSignedRoute(signed!.method === 'GET' ? 'POST' : 'GET', signed!.path)).toBe(
    false,
  );
  expect(isContractSignedRoute('POST', '/__not_in_contract')).toBe(false);
  // A HEAD route Fastify exposes for a GET route runs the GET handler.
  const get = contractSigningRoutes().find((route) => route.method === 'GET');
  expect(get).toBeDefined();
  expect(isContractSignedRoute('HEAD', get!.path)).toBe(get!.signed);
});
