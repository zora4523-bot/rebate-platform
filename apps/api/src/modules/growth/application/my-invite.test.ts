import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { createRootLogger, FixedClock } from '../../platform/index.ts';
import { createMyInviteReader, firstShareDomain, type MyInviteDeps } from './my-invite.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-00000000000a';
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

interface World {
  user: { invite_code: string; status: string; phone_hmac: string | null } | undefined;
  count: string;
  birth: string | null;
  risk: 'normal' | 'frozen' | 'appealing' | 'banned';
  domains: unknown;
}

async function fixture(overrides: Partial<World> = {}) {
  const world: World = {
    user: { invite_code: 'K7M2QX', status: 'normal', phone_hmac: 'f'.repeat(64) },
    count: '2',
    birth: null,
    risk: 'normal',
    domains: ['share.example.test'],
    ...overrides,
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const rows = (value: unknown[]) => ({ rows: value as R[] });
    if (query.sql.startsWith('select "invite_code", "status", "phone_hmac"')) {
      return rows(world.user ? [world.user] : []);
    }
    if (query.sql.startsWith('select count(*)')) return rows([{ count: world.count }]);
    throw new Error(`unexpected query: ${query.sql}`);
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const clock = new FixedClock('2026-09-29T12:00:00.000Z');
  const deps: MyInviteDeps = {
    clock,
    logger,
    db,
    config: {
      configValue: async () =>
        world.domains === undefined ? null : { value: world.domains, version: 1 },
    },
    readRisk: async () => ({ state: world.risk, reason_category: null, frozen_until: null }),
    verifiedBirthDate: async () => world.birth,
  };
  const read = () => createMyInviteReader(deps).read({ app_id: APP, user_id: USER });
  return { world, queries, lines, clock, read };
}

it('[AC-B1-11j] firstShareDomain accepts bare domains only and never falls back', () => {
  expect(firstShareDomain(['Share.Example.test', 'b.test'])).toBe('share.example.test');
  for (const value of [
    undefined,
    null,
    [],
    'a.test',
    [42, 'a.test'],
    [''],
    ['https://a.test'],
    ['a.test/path'],
    ['u@a.test'],
    ['a.test?x=1'],
    ['a.test:8080'],
    ['bad domain.test'],
    ['localhost'],
    ['10.0.0.1'],
    ['-a.test'],
  ]) {
    expect(firstShareDomain(value)).toBeNull();
  }
});

it('[AC-B1-11j] available user: code, landing link, null poster and live count', async () => {
  const f = await fixture();
  expect(await f.read()).toEqual({
    result: 'ok',
    invite: {
      can_invite: true,
      invite_code: 'K7M2QX',
      landing_url: 'https://share.example.test/i/K7M2QX',
      poster_url: null,
      direct_count: 2,
    },
  });
  const count = f.queries.find((q) => q.sql.startsWith('select count(*)'))!;
  expect(count.sql).toContain('"status" <> $3');
  expect(count.parameters).toEqual([APP, USER, 'deleted']);
});

it('[AC-B1-11j] verified minor answers minor before risk or count are read', async () => {
  const f = await fixture({ birth: '2010-06-01', risk: 'banned' });
  expect(await f.read()).toEqual({ result: 'minor' });
  expect(f.queries.some((q) => q.sql.startsWith('select count(*)'))).toBe(false);
});

it('[AC-B1-11j] age boundary follows the injected clock (BR-ID-26)', async () => {
  const f = await fixture({ birth: '2008-09-30' });
  f.clock.set('2026-09-30T15:59:59.999Z');
  expect(await f.read()).toEqual({ result: 'minor' });
  f.clock.set('2026-09-30T16:00:00.000Z');
  expect((await f.read()).result).toBe('ok');
});

for (const [label, patch] of [
  ['banned', { risk: 'banned' }],
  ['appealing', { risk: 'appealing' }],
  ['frozen', { risk: 'frozen' }],
  ['deleted', { user: { invite_code: 'K7M2QX', status: 'deleted', phone_hmac: 'f'.repeat(64) } }],
  ['no phone', { user: { invite_code: 'K7M2QX', status: 'normal', phone_hmac: null } }],
] as const) {
  it(`[AC-B1-11j] unavailable (${label}): code, link and poster null, count kept`, async () => {
    const f = await fixture(patch as Partial<World>);
    expect(await f.read()).toEqual({
      result: 'ok',
      invite: {
        can_invite: false,
        invite_code: null,
        landing_url: null,
        poster_url: null,
        direct_count: 2,
      },
    });
  });
}

it('[AC-B1-11j] invalid share_domains: landing_url null, warn with config_key only', async () => {
  const f = await fixture({ domains: ['https://share.example.test', 'ok.example.test'] });
  const result = await f.read();
  expect(result).toMatchObject({ invite: { can_invite: true, landing_url: null } });
  const warns = f.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatchObject({ level: 40, config_key: 'share_domains' });
  expect(JSON.stringify(warns[0])).not.toContain(USER);
});

it('[AC-B1-11j] missing subject row throws', async () => {
  const f = await fixture({ user: undefined });
  await expect(f.read()).rejects.toThrow('subject not found');
});
