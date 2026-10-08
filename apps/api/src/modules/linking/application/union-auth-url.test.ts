// Unit tests of the auth-url use case without a database (B1-06g fund review round 1): Kysely runs
// on a scripted driver answering the few read-only selects by table, to pin
//   - the site authorization judged on the union account this authorization actually uses (the
//     unreleased binding's, else the active self_buy pid's), never masked by another valid account;
//   - the Pinduoduo auth_jump built by the open's BR-ATTR-27 matrix from the device record's client
//     and installed (non-prod android installed=true: the app scheme first, the page after).
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/linking/auth-url).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionPidRow } from '../../union/index.ts';
import { createDemoUnionAuthApps } from '../infra/auth-apps.ts';
import { appSchemeOf, buildDefaultLinkJump, pathsOf } from './link-open-conversion.ts';
import type { LinkOpenApps, LinkOpenEnvironment } from './link-open-wiring.ts';
import { createUnionAuthUrl, type UnionAuthUrlOptions } from './union-auth-url.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';
const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-000000000001';
const DEVICE = '0199a3b4-5c6d-7000-8000-000000000002';
const EXPIRED_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000e1';
const VALID_ACCOUNT = '0199a3b4-5c6d-7000-8000-0000000000a1';

interface Account {
  readonly id: string;
  readonly platform: 'taobao' | 'pdd';
  readonly auth_status: 'active' | 'expiring' | 'expired';
}

interface Scenario {
  readonly client: 'ios' | 'android' | 'harmony';
  /** Ordered as the first-account fallback would read them. */
  readonly accounts: readonly Account[];
  readonly bindings?: readonly { readonly status: string; readonly union_account_id: string }[];
  readonly pidAccount?: string;
  readonly jumpEnvironment?: LinkOpenEnvironment;
}

function setup(scenario: Scenario) {
  const inserts: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const { sql, parameters } = compiled;
      const rows = (list: readonly object[]) => Promise.resolve({ rows: list } as QueryResult<R>);
      if (sql.startsWith('insert')) {
        inserts.push(compiled);
        return rows([]);
      }
      if (sql.includes('"devices"')) return rows([{ platform: scenario.client, revoked_at: null }]);
      if (sql.includes('"union_bindings"')) return rows(scenario.bindings ?? []);
      if (sql.includes('"user_risk_state"')) return rows([{ state: 'normal' }]);
      if (sql.includes('"union_accounts"')) {
        const platform = scenario.accounts.filter((a) => parameters.includes(a.platform));
        if (sql.includes('"id" =')) {
          return rows(platform.filter((a) => parameters.includes(a.id)));
        }
        return rows(platform.slice(0, 1));
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const getActivePid = vi.fn<NonNullable<UnionAuthUrlOptions['pids']>['getActivePid']>(
    async (input) =>
      scenario.pidAccount === undefined
        ? null
        : ({
            app_id: input.appId,
            platform: input.platform,
            pid_scene: input.pidScene,
            status: 'active',
            union_account_id: scenario.pidAccount,
          } as unknown as UnionPidRow),
  );
  const clock = new FixedClock('2026-10-08T00:00:00.000Z');
  const auth = createUnionAuthUrl({
    db,
    clock,
    appEnv: 'test',
    callerContext: { current: async () => ({ appId: APP, userId: USER, deviceId: DEVICE }) },
    config: { configValue: async () => null },
    authApps: createDemoUnionAuthApps(),
    pids: { getActivePid },
    ...(scenario.jumpEnvironment === undefined
      ? {}
      : { jumpEnvironment: scenario.jumpEnvironment }),
  });
  return { auth, inserts, getActivePid, clock };
}

describe('createUnionAuthUrl site authorization of the account in use', () => {
  it('[AC-B1-06g#6] the bound account expired → 30102 even while another account of the platform is valid', async () => {
    const { auth, inserts, getActivePid } = setup({
      client: 'ios',
      accounts: [
        { id: VALID_ACCOUNT, platform: 'taobao', auth_status: 'active' },
        { id: EXPIRED_ACCOUNT, platform: 'taobao', auth_status: 'expired' },
      ],
      bindings: [{ status: 'invalid', union_account_id: EXPIRED_ACCOUNT }],
      pidAccount: VALID_ACCOUNT,
    });
    const result = await auth.get({ platform: 'taobao', reportedClient: 'ios', traceId: TRACE });
    expect(result.envelope).toMatchObject({ code: 30102, data: { reason: 'auth_unavailable' } });
    expect(result.envelope).not.toHaveProperty('data.state');
    expect(getActivePid).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('[AC-B1-06g#6] unbound: the active self_buy pid account expired → 30101 even while the first account is valid', async () => {
    const { auth, inserts, getActivePid } = setup({
      client: 'ios',
      accounts: [
        { id: VALID_ACCOUNT, platform: 'taobao', auth_status: 'active' },
        { id: EXPIRED_ACCOUNT, platform: 'taobao', auth_status: 'expired' },
      ],
      pidAccount: EXPIRED_ACCOUNT,
    });
    const result = await auth.get({ platform: 'taobao', reportedClient: 'ios', traceId: TRACE });
    expect(result.envelope).toMatchObject({ code: 30101, data: { reason: 'auth_unavailable' } });
    expect(getActivePid).toHaveBeenCalledWith({
      appId: APP,
      platform: 'taobao',
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    expect(inserts).toEqual([]);
  });
});

/** A synthetic apps.json declaring a pdd scheme, so the matrix has a scheme step to order. */
const SYNTHETIC_APPS: LinkOpenApps = {
  apps: {
    jd: {
      status: 'candidate',
      ios: { query_schemes: [] },
      android: { packages: [] },
      harmony: { query_schemes: [] },
    },
    pdd: {
      status: 'candidate',
      ios: { query_schemes: ['synthpdd'] },
      android: { packages: ['test.example.synthpdd'] },
      harmony: { query_schemes: [] },
    },
  },
};

describe('createUnionAuthUrl pinduoduo auth_jump', () => {
  it('[AC-B1-06g#4] non-prod android installed=true follows the open matrix by the device record: scheme, then the page', async () => {
    const { auth, inserts, clock } = setup({
      client: 'android',
      accounts: [{ id: VALID_ACCOUNT, platform: 'pdd', auth_status: 'active' }],
      jumpEnvironment: { appEnv: 'test', apps: SYNTHETIC_APPS, verifiedPaths: {} },
    });
    // X-Platform says ios; the device record (android) decides.
    const result = await auth.get({
      platform: 'pdd',
      reportedClient: 'ios',
      installed: 'true',
      traceId: TRACE,
    });
    expect(result.status).toBe(200);
    const data = (result.envelope as { data: { auth_url: string; auth_jump: unknown } }).data;
    const scheme = appSchemeOf(SYNTHETIC_APPS, 'pdd');
    expect(scheme).toBe('synthpdd');
    const expected = buildDefaultLinkJump({
      platform: 'pdd',
      client: 'android',
      installed: 'true',
      paths: pathsOf('pdd', data.auth_url, scheme),
      expireAt: new Date(clock.now().getTime() + 600_000).toISOString(),
    });
    expect(data.auth_jump).toEqual(expected);
    expect(data.auth_jump).toMatchObject({
      primary: { type: 'scheme', value: expect.stringMatching(new RegExp(`^${scheme}://`)) },
      fallbacks: [{ type: 'h5', value: data.auth_url }],
    });
    expect(inserts).toHaveLength(1);
  });
});
