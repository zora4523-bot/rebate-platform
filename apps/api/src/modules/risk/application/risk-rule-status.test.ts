// Unit tests of the rule status reader without a database (B1-03zh, D10-536; BR-ID-36 细则
// 「规则清单的启停」): Kysely runs on a scripted driver whose risk_rules answer the test sets, to pin
// which statuses take part, the per-app cache on the injected Clock and the read through the given
// handle. The SQL itself runs against PostgreSQL in the rule tests (test/spec/risk/rule-toggle-identity).
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
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { RISK_RULE_STATUS_TTL_MS, createRiskRuleStatusReader } from './risk-rule-status.ts';

const AT = '2026-11-01T00:00:00.000Z';

/** risk_rules rows keyed `app_id/rule_id` → status; every statement is recorded. */
function scripted(statuses: Map<string, string>) {
  const statements: CompiledQuery[] = [];
  let failing = false;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      if (failing) return Promise.reject(new Error('down'));
      const [appId, ruleId] = compiled.parameters as [string, string];
      const status = statuses.get(`${appId}/${ruleId}`);
      return Promise.resolve({ rows: status === undefined ? [] : [{ status }] } as QueryResult<R>);
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
  return {
    db,
    statements,
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

it.each([
  ['enabled', true],
  ['active', true],
  ['disabled', false],
] as const)(
  '[AC-B1-03zh#1][BR-ID-36] 状态 %s：是否参与判定 = %s；按 app_id 与 rule_id 读 app.risk_rules',
  async (status, expected) => {
    const s = scripted(new Map([['app_a/RULE', status]]));
    const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
    expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(expected);
    expect(s.statements).toHaveLength(1);
    expect(s.statements[0]!.sql).toBe(
      'select "status" from "app"."risk_rules" where "app_id" = $1 and "rule_id" = $2',
    );
    expect(s.statements[0]!.parameters).toEqual(['app_a', 'RULE']);
  },
);

it('[AC-B1-03zh#1][BR-ID-36] 无规则行：照旧参与判定（由写入方首次命中时登记）', async () => {
  const s = scripted(new Map());
  const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'DEVICE_REGISTER_LIMIT' }, s.db)).toBe(
    true,
  );
});

it('[AC-B1-03zh#1][BR-ID-36] 缓存周期内不重读；满周期后重读并取新状态（只看注入的 Clock）', async () => {
  const statuses = new Map([['app_a/RULE', 'enabled']]);
  const s = scripted(statuses);
  const clock = new FixedClock(AT);
  const reader = createRiskRuleStatusReader({ clock });
  // The configuration items' period (规划/04 §10.2), restated in risk: pinned together here.
  expect(RISK_RULE_STATUS_TTL_MS).toBe(60_000);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(true);
  statuses.set('app_a/RULE', 'disabled');
  clock.advanceMs(RISK_RULE_STATUS_TTL_MS - 1);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(true);
  expect(s.statements).toHaveLength(1);
  clock.advanceMs(1);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(false);
  expect(s.statements).toHaveLength(2);
  statuses.set('app_a/RULE', 'enabled');
  clock.advanceMs(RISK_RULE_STATUS_TTL_MS);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(true);
});

it('[AC-B1-03zh#1] 时钟回拨视为过期，重读', async () => {
  const s = scripted(new Map([['app_a/RULE', 'enabled']]));
  const clock = new FixedClock(AT);
  const reader = createRiskRuleStatusReader({ clock });
  await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db);
  clock.advanceMs(-1);
  await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db);
  expect(s.statements).toHaveLength(2);
});

it('[AC-B1-03zh#2][BR-ID-36] 跨 app 隔离：A 停用不影响 B 同名规则，缓存各自独立', async () => {
  const s = scripted(
    new Map([
      ['app_a/RULE', 'disabled'],
      ['app_b/RULE', 'enabled'],
    ]),
  );
  const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(false);
  expect(await reader.isEnabled({ app_id: 'app_b', rule_id: 'RULE' }, s.db)).toBe(true);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'OTHER' }, s.db)).toBe(true);
  expect(s.statements.map((q) => q.parameters)).toEqual([
    ['app_a', 'RULE'],
    ['app_b', 'RULE'],
    ['app_a', 'OTHER'],
  ]);
});

it('[AC-B1-03zh#1] 未命中缓存时经调用方给的 handle（事务）读', async () => {
  const s = scripted(new Map([['app_a/RULE', 'disabled']]));
  const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  const answer = await s.db
    .transaction()
    .execute((trx) => reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, trx));
  expect(answer).toBe(false);
  expect(s.statements).toHaveLength(1);
});

it('[AC-B1-03zh#1] 读取失败照常抛出、不缓存；恢复后重读', async () => {
  const s = scripted(new Map([['app_a/RULE', 'disabled']]));
  const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  s.fail(true);
  await expect(reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).rejects.toThrow(
    'down',
  );
  s.fail(false);
  expect(await reader.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(false);
  expect(s.statements).toHaveLength(2);
});

it('[AC-B1-03zh#1] 参数不合法：不发 SQL 直接抛 TypeError；ttlMs 不合法抛 RangeError', async () => {
  const s = scripted(new Map());
  const reader = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  await expect(reader.isEnabled({ app_id: '', rule_id: 'RULE' }, s.db)).rejects.toBeInstanceOf(
    TypeError,
  );
  await expect(reader.isEnabled({ app_id: 'app_a', rule_id: '' }, s.db)).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(s.statements).toEqual([]);
  expect(() => createRiskRuleStatusReader({ clock: new FixedClock(AT), ttlMs: -1 })).toThrow(
    RangeError,
  );
});

it('[AC-B1-03zh#1] 未给 executor 时经默认 db 读；默认 db 与 executor 都没有时抛 TypeError、不缓存', async () => {
  const s = scripted(new Map([['app_a/RULE', 'disabled']]));
  const withDb = createRiskRuleStatusReader({ db: s.db, clock: new FixedClock(AT) });
  expect(await withDb.isEnabled({ app_id: 'app_a', rule_id: 'RULE' })).toBe(false);
  expect(s.statements).toHaveLength(1);
  const bare = createRiskRuleStatusReader({ clock: new FixedClock(AT) });
  await expect(bare.isEnabled({ app_id: 'app_a', rule_id: 'RULE' })).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(await bare.isEnabled({ app_id: 'app_a', rule_id: 'RULE' }, s.db)).toBe(false);
  expect(s.statements).toHaveLength(2);
});
