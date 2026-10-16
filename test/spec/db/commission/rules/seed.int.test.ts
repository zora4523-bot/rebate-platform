import { existsSync, readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { TIMEOUT, close, open, requireTables, sqlState, type Harness, type Row } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const KEYS = [
  'commission.platforms',
  'union.pdd.account_level_factor_bp',
  'union.pdd.self_buy_factor_bp',
];

async function seed(target: Harness): Promise<void> {
  const path = new URL('../../../../../db/seeds/0002_commission-rules.sql', import.meta.url);
  expect(existsSync(path), 'B2-01d seed file').toBe(true);
  const source = readFileSync(path, 'utf8');
  expect(
    await sqlState(
      target.app.transaction().execute(async (trx) => {
        await sql.raw(source).execute(trx);
      }),
    ),
    'seed executes with couli_app SELECT/INSERT privileges',
  ).toBe('ok');
}

async function snapshot(target: Harness) {
  const versions = (
    await sql<Row>`SELECT * FROM app.commission_rule_versions
    WHERE app_id = 'couli' ORDER BY rule_version_id`.execute(target.app)
  ).rows;
  const rules = (
    await sql<Row>`SELECT * FROM app.commission_rules
    WHERE app_id = 'couli' ORDER BY rule_version_id, platform, level, order_type`.execute(
      target.app,
    )
  ).rows;
  const reserves = (
    await sql<Row>`SELECT * FROM app.commission_rule_reserves
    WHERE app_id = 'couli' ORDER BY rule_version_id, platform`.execute(target.app)
  ).rows;
  const configs = (
    await sql<Row>`SELECT * FROM app.config_items
    WHERE app_id = 'couli' AND key IN (${sql.join(KEYS)}) ORDER BY key`.execute(target.app)
  ).rows;
  return { versions, rules, reserves, configs };
}

it(
  '[AC-B2-01d#15] BR-CALC-02/05/06/17 占位种子含一个版本、18 行比例、3 行预留、三个配置且重复执行不变',
  async () => {
    await requireTables(h.app);
    await seed(h);
    const first = await snapshot(h);
    expect(first.versions).toEqual([
      expect.objectContaining({
        app_id: 'couli',
        status: 'published',
        indirect_enabled: false,
        effective_from: new Date('2026-01-01T00:00:00+08:00'),
        rule_version_id: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
      }),
    ]);
    const id = first.versions[0]!['rule_version_id'];
    const expectedRules = ['taobao', 'jd', 'pdd'].flatMap((platform) =>
      ['L1', 'L2', 'L3'].flatMap((level) =>
        ['self', 'share'].map((order_type) =>
          expect.objectContaining({
            app_id: 'couli',
            rule_version_id: id,
            platform,
            level,
            order_type,
            r_own_bp: 5000,
            r_direct_bp: 1000,
            r_indirect_bp: 0,
          }),
        ),
      ),
    );
    expect(first.rules).toHaveLength(18);
    expect(first.rules).toEqual(expect.arrayContaining(expectedRules));
    expect(first.reserves).toHaveLength(3);
    expect(first.reserves).toEqual(
      expect.arrayContaining(
        ['taobao', 'jd', 'pdd'].map((platform) =>
          expect.objectContaining({
            app_id: 'couli',
            rule_version_id: id,
            platform,
            reserve_bp: 0,
          }),
        ),
      ),
    );
    expect(first.configs).toEqual([
      expect.objectContaining({ app_id: 'couli', key: KEYS[0], value: ['taobao', 'jd', 'pdd'] }),
      expect.objectContaining({ app_id: 'couli', key: KEYS[1], value: 10000 }),
      expect.objectContaining({ app_id: 'couli', key: KEYS[2], value: 7500 }),
    ]);
    await seed(h);
    expect(await snapshot(h)).toEqual(first);
  },
  TIMEOUT,
);

it(
  '[AC-B2-01d#16] 固定版本 UUID 在独立数据库一致，重跑不得覆盖已有配置值与修订信息',
  async () => {
    await requireTables(h.app);
    await seed(h);
    const first = await snapshot(h);
    expect(first.versions).toHaveLength(1);
    const fresh = await open();
    try {
      await requireTables(fresh.app);
      for (const [key, value] of [
        [KEYS[0]!, ['taobao']],
        [KEYS[1]!, 9000],
        [KEYS[2]!, 6500],
      ] as const) {
        await sql`INSERT INTO app.config_items (app_id, key, value, version, updated_by)
        VALUES ('couli', ${key}, ${JSON.stringify(value)}::jsonb, 7, 'fixture-operator')`.execute(
          fresh.app,
        );
      }
      const before = (await snapshot(fresh)).configs;
      expect(before).toHaveLength(3);
      await seed(fresh);
      const seeded = await snapshot(fresh);
      expect(seeded.versions).toHaveLength(1);
      expect(seeded.versions[0]!['rule_version_id']).toBe(first.versions[0]!['rule_version_id']);
      expect(seeded.configs).toEqual(before);
      await seed(fresh);
      expect(await snapshot(fresh)).toEqual(seeded);
    } finally {
      await close(fresh);
    }
  },
  TIMEOUT,
);
