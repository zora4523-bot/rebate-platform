import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { expect, it } from 'vitest';
import { contractAuthOf, contractAuthRoutes } from './auth-routes.ts';
import { authRoutesFile, authRoutesSource } from './scripts/generate-auth-routes.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

it('[BR-ID-01] the generated x-auth table matches the current contract', async () => {
  expect(
    await readFile(authRoutesFile, 'utf8'),
    'auth-routes.gen.ts drifted from contracts/openapi.yaml: regenerate it from the repository ' +
      'root with `node apps/api/src/modules/platform/http/scripts/generate-auth-routes.ts`',
  ).toBe(await authRoutesSource());
});

it('[BR-ID-01][04 §5] lists every contract operation once with its x-auth, planned ones included', async () => {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const expected: { method: string; path: string; auth: unknown }[] = [];
  let planned = 0;
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item?.[method] as Record<string, unknown> | undefined;
      if (operation === undefined) continue;
      if ('x-implementation' in operation) planned += 1;
      expected.push({
        method: method.toUpperCase(),
        path: path.replace(/\{([^}]+)\}/g, ':$1'),
        auth: operation['x-auth'],
      });
    }
  }
  expect(planned).toBeGreaterThan(0);
  const routes = contractAuthRoutes();
  expect([...routes]).toEqual(expected);
  expect(Object.isFrozen(routes)).toBe(true);
  expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);
  for (const route of routes) {
    expect(contractAuthOf(route.method.toLowerCase(), route.path)).toBe(route.auth);
  }
});

it('[BR-ID-01] HEAD follows its GET operation; unmatched or undeclared routes have no level', () => {
  const get = contractAuthRoutes().find((route) => route.method === 'GET');
  expect(get).toBeDefined();
  expect(contractAuthOf('HEAD', get!.path)).toBe(get!.auth);
  expect(contractAuthOf('GET', `${get!.path}/undeclared`)).toBeUndefined();
  expect(contractAuthOf('DELETE', '/healthz')).toBeUndefined();
  expect(contractAuthOf('HEAD', '/outside-the-contract')).toBeUndefined();
  expect(contractAuthOf('POST', '/v1/auth/logout')).toBe('login');
});
