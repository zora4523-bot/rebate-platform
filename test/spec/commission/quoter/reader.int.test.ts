import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RuleVersion } from '../../../../apps/api/src/modules/commission/domain/rules.ts';
import { version, commission } from './fixtures.ts';

const { createRuleSetReader } = commission;

let database: TestDatabase | undefined;
let writer: Kysely<DB> | undefined;
let readerDb: Kysely<DB>;

beforeAll(async () => {
  // Shared globalSetup reads TEST_PG_ADMIN_URL; clone its migrated one-shot template.
  // Only integration runner / container may execute this file, never the Codex host.
  database = await createTestDatabase();
  writer = createDb({ connectionString: database.urlFor('couli_app') });
  readerDb = createDb({ connectionString: database.urlFor('couli_readonly') });
}, 60_000);

afterAll(async () => {
  try {
    if (readerDb) await destroyDb(readerDb);
    if (writer) await destroyDb(writer);
  } finally {
    await database?.drop();
  }
}, 60_000);

async function seed(
  appId: string,
  status: 'draft' | 'published' | 'revoked',
  overrides: Partial<RuleVersion> = {},
  revokedAt: Date | null = null,
): Promise<RuleVersion> {
  const v = version({ ...overrides, rule_version_id: randomUUID() });
  await writer!
    .withSchema('app')
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: v.rule_version_id,
      status,
      effective_from: v.effective_from,
      indirect_enabled: v.indirect_enabled,
      revoked_at: revokedAt,
      published_at: status === 'draft' ? null : new Date('2026-09-01T00:00:00+08:00'),
    })
    .execute();
  if (v.rules.length > 0)
    await writer!
      .withSchema('app')
      .insertInto('commission_rules')
      .values(v.rules.map((r) => ({ ...r, app_id: appId, rule_version_id: v.rule_version_id })))
      .execute();
  if (v.reserves.length > 0)
    await writer!
      .withSchema('app')
      .insertInto('commission_rule_reserves')
      .values(v.reserves.map((r) => ({ ...r, app_id: appId, rule_version_id: v.rule_version_id })))
      .execute();
  return v;
}

it('[AC-B2-03c#36] BR-CALC-11 仓储只返回本 app 已发布未撤销版本，包含未来版且只读', async () => {
  const reader = createRuleSetReader({ db: readerDb });
  const app = `quoter-${randomUUID()}`;
  const first = await seed(app, 'published');
  const future = await seed(app, 'published', {
    effective_from: new Date('2099-01-01T00:00:00+08:00'),
  });
  await seed(app, 'draft');
  await seed(app, 'revoked', {}, new Date('2026-09-15T00:00:00+08:00'));
  await seed(`${app}-other`, 'published');
  // Defense against inconsistent status/timestamp data: revoked_at must also be null.
  await seed(
    app,
    'published',
    { effective_from: new Date('2026-10-15T00:00:00+08:00') },
    new Date('2026-10-14T00:00:00+08:00'),
  );
  const actual = await reader.publishedVersions(app);
  expect(actual.map((v) => v.rule_version_id).sort()).toEqual(
    [first.rule_version_id, future.rule_version_id].sort(),
  );
  expect(await reader.publishedVersions(`${app}-absent`)).toEqual([]);
});

it('[AC-B2-03c#37] BR-CALC-06 读全每版 18 行三比例与 3 行预留，不混版本或 app', async () => {
  const reader = createRuleSetReader({ db: readerDb });
  const app = `quoter-${randomUUID()}`;
  const distinct = version({
    indirect_enabled: true,
    rules: version().rules.map((r, i) => ({
      ...r,
      r_own_bp: 4000 + i,
      r_direct_bp: 1000 + i,
      r_indirect_bp: 500 + i,
    })),
    reserves: [
      { platform: 'taobao', reserve_bp: 1234 },
      { platform: 'jd', reserve_bp: 2345 },
      { platform: 'pdd', reserve_bp: 3456 },
    ],
  });
  const a = await seed(app, 'published', distinct);
  const b = await seed(app, 'published', { effective_from: new Date('2026-11-01T00:00:00+08:00') });
  await seed(`${app}-other`, 'published', {
    rules: version().rules.map((r) => ({ ...r, r_own_bp: 1 })),
  });
  const actual = await reader.publishedVersions(app);
  expect(actual).toHaveLength(2);
  for (const expected of [a, b]) {
    const found = actual.find((v) => v.rule_version_id === expected.rule_version_id);
    expect(found).toBeDefined();
    expect(found?.effective_from).toEqual(expected.effective_from);
    expect(found?.indirect_enabled).toBe(expected.indirect_enabled);
    expect(found?.rules).toHaveLength(18);
    expect(found?.rules).toEqual(expect.arrayContaining([...expected.rules]));
    expect(found?.reserves).toHaveLength(3);
    expect(found?.reserves).toEqual(expect.arrayContaining([...expected.reserves]));
  }
});

it('[AC-B2-03c#38] BR-CALC-06 不完整的新版本也返回给领域拒绝，不因内连接被悄悄过滤', async () => {
  const reader = createRuleSetReader({ db: readerDb });
  const app = `quoter-${randomUUID()}`;
  await seed(app, 'published');
  const emptyRules = await seed(app, 'published', {
    effective_from: new Date('2026-11-01T00:00:00+08:00'),
    rules: [],
  });
  const emptyReserves = await seed(app, 'published', {
    effective_from: new Date('2026-12-01T00:00:00+08:00'),
    reserves: [],
  });
  const actual = await reader.publishedVersions(app);
  expect(actual).toHaveLength(3);
  expect(actual.find((v) => v.rule_version_id === emptyRules.rule_version_id)?.rules).toEqual([]);
  expect(actual.find((v) => v.rule_version_id === emptyReserves.rule_version_id)?.reserves).toEqual(
    [],
  );
});
