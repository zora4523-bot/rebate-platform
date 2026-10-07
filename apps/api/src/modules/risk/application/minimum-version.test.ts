import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  CONDITIONAL_EXEMPTIONS,
  MINIMUM_VERSION_SCOPE,
  contractMinimumVersionRoutes,
  createMinimumVersionCheck,
  createMinimumVersionPostMissCheck,
  type MinimumVersionRequest,
} from './minimum-version.ts';
import {
  minVersionRoutesFile,
  minVersionRoutesSource,
} from './scripts/generate-min-version-routes.ts';

const request = (overrides: Partial<MinimumVersionRequest> = {}): MinimumVersionRequest => ({
  id: 'trace-1',
  method: 'POST',
  headers: {
    'x-app-id': 'couli',
    'x-platform': 'android',
    'x-channel': 'huawei',
    'x-app-version': '1.0.0',
  },
  routeOptions: { url: '/v1/withdrawals' },
  body: {},
  ...overrides,
});

it('[BR-ID-01] the generated minimum version table matches the current contract', async () => {
  expect(
    await readFile(minVersionRoutesFile, 'utf8'),
    'min-version-routes.gen.ts drifted from contracts/openapi.yaml: regenerate it from the ' +
      'repository root with `node apps/api/src/modules/risk/application/scripts/generate-min-version-routes.ts`',
  ).toBe(await minVersionRoutesSource());
});

it('[BR-ID-01] every conditional operation of the contract has its exempting body, and only those', () => {
  const conditional = contractMinimumVersionRoutes()
    .filter((route) => route.gate === 'conditional')
    .map((route) => `${route.method} ${route.path}`)
    .sort();
  expect(Object.keys(CONDITIONAL_EXEMPTIONS).sort()).toEqual(conditional);
});

it('[BR-ID-01] a missing X-Channel reads as no configured row and is not judged', async () => {
  const read = vi.fn(async () => '9.0.0');
  const check = createMinimumVersionCheck({ minSupportedVersion: read });
  await expect(
    check(request({ headers: { 'x-app-id': 'couli', 'x-platform': 'android' } })),
  ).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it('[BR-ID-01] a malformed configured minimum fails closed instead of letting the request through', async () => {
  const check = createMinimumVersionCheck({ minSupportedVersion: async () => 'latest' });
  await expect(
    check(request({ headers: { ...request().headers, 'x-app-version': '99.0.0' } })),
  ).rejects.toThrow(TypeError);
});

it('[BR-ID-01] a non-object body never exempts a conditional operation', async () => {
  const check = createMinimumVersionCheck({ minSupportedVersion: async () => '2.0.0' });
  for (const body of [null, undefined, 'account_deletion', [{ action: 'account_deletion' }]]) {
    await expect(
      check(request({ routeOptions: { url: '/v1/auth/step-up' }, body })),
    ).rejects.toMatchObject({ status: 403 });
  }
});

it('[BR-ID-01] the post-miss hook judges the HTTP request of its own async context only', async () => {
  const seen: string[] = [];
  const hook = createMinimumVersionPostMissCheck(async (input) => {
    seen.push(input.id);
  });
  const idempotent = {} as Parameters<typeof hook>[0];
  await hook(idempotent);
  expect(seen).toEqual([]);
  await Promise.all(
    ['a', 'b'].map((id) =>
      MINIMUM_VERSION_SCOPE.run(request({ id }), async () => {
        await Promise.resolve();
        await hook(idempotent);
      }),
    ),
  );
  expect(seen.sort()).toEqual(['a', 'b']);
});
