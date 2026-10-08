import { readFile } from 'node:fs/promises';
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  createIdempotency,
  idempotencyPostMissTransaction,
  registerIdempotencyPostMissCheck,
  type IdempotentRequest,
} from '../../platform/index.ts';
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
      MINIMUM_VERSION_SCOPE.run(
        { request: request({ id }), idempotencyEntered: false },
        async () => {
          await Promise.resolve();
          await hook(idempotent);
        },
      ),
    ),
  );
  expect(seen.sort()).toEqual(['a', 'b']);
});

/** A scripted pool: counts connection checkouts and logs which client ran which statement. */
function scriptedPool() {
  const log: string[] = [];
  let checkouts = 0;
  const pool = {
    async connect() {
      checkouts += 1;
      const client = checkouts;
      return {
        release: () => undefined,
        async query(text: string) {
          log.push(`${client}:${text}`);
          let rows: unknown[] = [];
          if (text.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: true }];
          else if (text.includes('current_setting')) rows = [{ value: '0' }];
          else if (text.includes('app_versions'))
            rows = [{ channel: 'huawei', min_supported_version: '2.0.0' }];
          return { command: 'SELECT', rowCount: rows.length, rows };
        },
      };
    },
    end: async () => undefined,
    options: {},
  };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  return { db, log, checkouts: () => checkouts };
}

for (const mode of ['execute', 'executeInTransaction'] as const) {
  it(`[BR-ID-01] ${mode}: the post-miss hook reads the minimum on the claim's transaction, never on a second pooled connection`, async () => {
    const { db, log, checkouts } = scriptedPool();
    const idempotency = createIdempotency({
      db,
      clock: new FixedClock('2031-01-01T00:00:00Z'),
      logger: { warn: () => undefined },
    });
    const pooled = vi.fn(async () => '2.0.0');
    const handles: Kysely<DB>[] = [];
    const readerOn = (handle: Kysely<DB>) => {
      handles.push(handle);
      return {
        async minSupportedVersion() {
          const rows = await handle
            .selectFrom('app_versions')
            .select(['channel', 'min_supported_version'])
            .execute();
          return rows[0]?.min_supported_version ?? null;
        },
      };
    };
    registerIdempotencyPostMissCheck(
      idempotency,
      createMinimumVersionPostMissCheck(
        createMinimumVersionCheck({ minSupportedVersion: pooled }),
        readerOn,
      ),
    );
    const input: IdempotentRequest = {
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method: 'POST',
      path: mode === 'execute' ? '/v1/links/l/open' : '/v1/withdrawals',
      key: '019a0000-0000-7000-8000-0000000000aa',
      body: {},
      traceId: 'trace-1',
    };
    const handler = vi.fn(async () => ({
      status: 200,
      envelope: { code: 0, msg: '', trace_id: 'trace-1' },
    }));
    await MINIMUM_VERSION_SCOPE.run({ request: request(), idempotencyEntered: true }, async () => {
      await expect(
        mode === 'execute'
          ? idempotency.execute(input, handler)
          : idempotency.executeInTransaction(input, handler),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 10405, data: { min_supported_version: '2.0.0' } },
      });
    });
    expect(checkouts()).toBe(1);
    expect(pooled).not.toHaveBeenCalled();
    expect(handles).toHaveLength(1);
    expect(handles[0]).not.toBe(db);
    const read = log.findIndex((line) => line.includes('app_versions'));
    expect(read).toBeGreaterThan(log.findIndex((line) => line.includes('idempotency_keys')));
    expect(log[read]!.startsWith('1:')).toBe(true);
    expect(log.some((line) => /^1:insert/i.test(line))).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    await db.destroy();
  });
}

it('[BR-ID-01] outside a post-miss check there is no claim transaction to read on', () => {
  expect(idempotencyPostMissTransaction()).toBeUndefined();
});
