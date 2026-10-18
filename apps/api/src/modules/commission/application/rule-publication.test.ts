import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock, type AuditPort, type Clock } from '../../platform/index.ts';
import {
  RulePublicationError,
  publish,
  revoke,
  runTrial,
  type RulePublicationDependencies,
} from './rule-publication.ts';
import type { SnapshotBeneficiaries, SnapshotBeneficiaryResolver } from './snapshot.ts';

const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
const APP = 'unit-app';
const NOW = '2030-06-12T12:00:00+08:00';
const PAID_AT = new Date('2030-06-10T10:00:00+08:00');

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

type Responder = (query: CompiledQuery) => unknown[];

/** A Kysely handle whose queries are answered by `respond`; every statement is logged. */
async function fakeDb(respond: Responder, log: string[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    log.push(query.sql);
    return { rows: respond(query) as R[] };
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
  return db;
}

function versionRow(over: Record<string, unknown>) {
  return {
    app_id: APP,
    status: 'draft',
    effective_from: new Date('2030-06-13T12:00:00+08:00'),
    indirect_enabled: false,
    base_version_id: null,
    drafter_id: 'drafter',
    publisher_id: null,
    published_at: null,
    revoked_at: null,
    created_at: new Date('2030-06-12T11:00:00+08:00'),
    indirect_approver_id: null,
    indirect_approved_at: null,
    ...over,
  };
}

function rules(indirectBp: number) {
  return PLATFORMS.flatMap((platform) =>
    ['L1', 'L2', 'L3'].flatMap((level) =>
      ['self', 'share'].map((order_type) => ({
        platform,
        level,
        order_type,
        r_own_bp: 5000,
        r_direct_bp: 1000,
        r_indirect_bp: indirectBp,
      })),
    ),
  );
}

const base = versionRow({
  rule_version_id: 'base',
  status: 'published',
  effective_from: new Date('2030-06-01T00:00:00+08:00'),
  published_at: new Date('2030-05-31T00:00:00+08:00'),
});
const draft = versionRow({
  rule_version_id: 'draft',
  indirect_enabled: true,
  base_version_id: 'base',
});

const owner = { userId: 'C', level: 'L1', status: 'active', forfeitReason: null } as const;
const direct = { userId: 'B', level: 'L2', status: 'active', forfeitReason: null } as const;
const grand = { userId: 'A', level: 'L3', status: 'active', forfeitReason: null } as const;

/** A snapshot made under the indirect-off base: only C (self) and B (direct), N = 1000. */
const split = {
  app_id: APP,
  order_id: 'order-1',
  platform: 'taobao',
  rule_version_id: 'base',
  order_type: 'self',
  activity_type: null,
  rebate_mode: null,
  paid_at: PAID_AT,
  paid_at_source: 'platform',
  raw_n_fen: 1000n,
  subsidy_commission_fen: 0n,
  reserve_bp: 0,
  reserve_fen: 0n,
  tlj_deduct_fen: 0n,
  base_fen: 1000n,
  platform_retain_fen: 400n,
  beneficiaries: [
    {
      user_id: 'C',
      role: 'self',
      ratio_bp: 5000,
      level: 'L1',
      initial_status: 'active',
      forfeit_reason: null,
    },
    {
      user_id: 'B',
      role: 'direct',
      ratio_bp: 1000,
      level: 'L2',
      initial_status: 'active',
      forfeit_reason: null,
    },
  ],
  created_at: new Date(NOW),
};

/** Answers the statements of runTrial for the base / draft / one sample above. */
function trialResponder(): Responder {
  return (query) => {
    const sql = query.sql;
    const p = query.parameters;
    if (sql.startsWith('insert into "app"."commission_rule_trials"')) {
      return [
        {
          trial_id: p[0],
          app_id: p[1],
          rule_version_id: p[2],
          base_version_id: p[3],
          sample_from: p[4],
          sample_to: p[5],
          sample_count: p[6],
          sample_hash: p[7],
          report: JSON.parse(String(p[8])),
          created_by: p[9],
          created_at: p[10],
        },
      ];
    }
    if (sql.includes('"commission_rules"')) return rules(p[1] === 'draft' ? 500 : 0);
    if (sql.includes('"commission_rule_reserves"')) {
      return PLATFORMS.map((platform) => ({ platform, reserve_bp: 0 }));
    }
    if (sql.includes('"commission_splits" as "s"')) return [split];
    if (sql.includes('"commission_split_amounts"')) return [];
    if (sql.includes('"commission_rule_versions"')) {
      if (sql.includes('"rule_version_id" = $2')) return [draft];
      return [base, draft];
    }
    throw new Error(`unexpected statement ${sql}`);
  };
}

function deps(resolver?: SnapshotBeneficiaryResolver, clock: Clock = new FixedClock(NOW)) {
  const append = vi.fn<AuditPort['append']>(async () => {});
  const d: RulePublicationDependencies = {
    clock,
    platforms: PLATFORMS,
    audit: { append },
    ...(resolver === undefined ? {} : { beneficiaries: resolver }),
  };
  return { deps: d, append };
}

function resolverOf(answer: () => Promise<SnapshotBeneficiaries>) {
  return { resolve: vi.fn<SnapshotBeneficiaryResolver['resolve']>(answer) };
}

const context = { appId: APP, actor: { adminUserId: 'trialist' }, draftId: 'draft' };

async function expectCode(promise: Promise<unknown>, code: string) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RulePublicationError);
  expect((error as RulePublicationError).code).toBe(code);
}

it('[AC-B2-03k-UNIT#7] 草稿开间推而快照无间推人：经解析器按 paid_at 补出间推人，草稿间推 50、留存 350', async () => {
  const log: string[] = [];
  const db = await fakeDb(trialResponder(), log);
  const resolver = resolverOf(async () => ({ owner, direct, indirect: grand, warnings: [] }));
  const { deps: d, append } = deps(resolver);
  const result = await db.transaction().execute((tx) => runTrial(tx, context, d));
  expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    appId: APP,
    ownerUserId: 'C',
    paidAt: PAID_AT,
  });
  const taobao = result.report.platforms.find((r) => r.platform === 'taobao');
  expect(taobao?.draft).toEqual({
    reserveBp: 0,
    reserveFen: 0,
    ownFen: 500,
    directFen: 100,
    indirectFen: 50,
    platformRetainFen: 350,
  });
  expect(taobao?.current).toEqual({
    reserveBp: 0,
    reserveFen: 0,
    ownFen: 500,
    directFen: 100,
    indirectFen: 0,
    platformRetainFen: 400,
  });
  expect(log.some((sql) => sql.startsWith('insert into "app"."commission_rule_trials"'))).toBe(
    true,
  );
  expect(append).toHaveBeenCalledOnce();
});

it('[AC-B2-03k-UNIT#8] 解析器答「paid_at 时直推人无上级」：间推为 0，份额留给平台', async () => {
  const db = await fakeDb(trialResponder(), []);
  const resolver = resolverOf(async () => ({ owner, direct, indirect: null, warnings: [] }));
  const result = await db.transaction().execute((tx) => runTrial(tx, context, deps(resolver).deps));
  const taobao = result.report.platforms.find((r) => r.platform === 'taobao');
  expect(taobao?.draft.indirectFen).toBe(0);
  expect(taobao?.draft.platformRetainFen).toBe(400);
});

const failing: { name: string; resolver: () => SnapshotBeneficiaryResolver | undefined }[] = [
  { name: '未注入解析器', resolver: () => undefined },
  {
    name: '解析器抛错',
    resolver: () => resolverOf(() => Promise.reject(new Error('relation log unavailable'))),
  },
  {
    name: '解析出的直推人与快照不一致',
    resolver: () =>
      resolverOf(async () => ({
        owner,
        direct: { ...direct, userId: 'X' },
        indirect: grand,
        warnings: [],
      })),
  },
  {
    name: '解析出的直推人等级与快照不一致',
    resolver: () =>
      resolverOf(async () => ({
        owner,
        direct: { ...direct, level: 'L3' },
        indirect: grand,
        warnings: [],
      })),
  },
  {
    name: '解析结果缺直推人',
    resolver: () =>
      resolverOf(async () => ({ owner, direct: null, indirect: grand, warnings: [] })),
  },
  {
    name: '解析出的本人与快照不一致',
    resolver: () =>
      resolverOf(async () => ({
        owner: { ...owner, userId: 'Z' },
        direct,
        indirect: grand,
        warnings: [],
      })),
  },
];

for (const [i, c] of failing.entries()) {
  it(`[AC-B2-03k-UNIT#9.${i + 1}] 间推人无法确定（${c.name}）→ TRIAL_FAILED，不写试算、不记审计`, async () => {
    const log: string[] = [];
    const db = await fakeDb(trialResponder(), log);
    const { deps: d, append } = deps(c.resolver());
    await expectCode(
      db.transaction().execute((tx) => runTrial(tx, context, d)),
      'TRIAL_FAILED',
    );
    expect(log.some((sql) => sql.startsWith('insert into'))).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
}

it('[AC-B2-03k-UNIT#10] 快照已有间推人或草稿与现行都关间推：不调用解析器', async () => {
  const withIndirect = {
    ...split,
    beneficiaries: [
      ...split.beneficiaries,
      {
        user_id: 'A',
        role: 'indirect',
        ratio_bp: 0,
        level: 'L3',
        initial_status: 'active',
        forfeit_reason: null,
      },
    ],
  };
  const respond = trialResponder();
  const db = await fakeDb(
    (q) => (q.sql.includes('"commission_splits" as "s"') ? [withIndirect] : respond(q)),
    [],
  );
  const resolver = resolverOf(async () => ({ owner, direct, indirect: grand, warnings: [] }));
  const result = await db.transaction().execute((tx) => runTrial(tx, context, deps(resolver).deps));
  expect(resolver.resolve).not.toHaveBeenCalled();
  expect(result.report.platforms.find((r) => r.platform === 'taobao')?.draft.indirectFen).toBe(50);
});

/** A clock that moves forward while the FOR UPDATE statement waits (another writer held the lock). */
function lockWaitingDb(respond: Responder, clock: FixedClock, waitMs: number, log: string[]) {
  return fakeDb((query) => {
    if (query.sql.endsWith('for update')) clock.advanceMs(waitMs);
    return respond(query);
  }, log);
}

it('[AC-B2-03k-UNIT#11] 撤销在取得版本行锁后读 Clock：锁等待期间到了 effective_from → 已生效不可撤销', async () => {
  const clock = new FixedClock('2030-06-13T11:59:00+08:00');
  const published = versionRow({
    rule_version_id: 'v2',
    status: 'published',
    effective_from: new Date('2030-06-13T12:00:00+08:00'),
    published_at: new Date('2030-06-12T12:00:00+08:00'),
  });
  const log: string[] = [];
  const db = await lockWaitingDb(
    (q) => (q.sql.includes('"commission_rule_versions"') ? [published] : []),
    clock,
    120_000,
    log,
  );
  const now = vi.spyOn(clock, 'now');
  const { deps: d, append } = deps(undefined, clock);
  await expectCode(
    db
      .transaction()
      .execute((tx) => revoke(tx, { appId: APP, actor: { adminUserId: 'r' }, versionId: 'v2' }, d)),
    'VERSION_ALREADY_EFFECTIVE',
  );
  expect(now).toHaveBeenCalled();
  expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
  expect(append).not.toHaveBeenCalled();
});

it('[AC-B2-03k-UNIT#12] 发布在取得版本行锁后读 Clock：锁等待使试算超过 10 分钟 → TRIAL_EXPIRED', async () => {
  const clock = new FixedClock('2030-06-12T12:09:00+08:00');
  const first = versionRow({ rule_version_id: 'draft', indirect_enabled: true });
  const trial = {
    trial_id: 't1',
    app_id: APP,
    rule_version_id: 'draft',
    base_version_id: null,
    sample_from: new Date('2030-06-05T12:00:00+08:00'),
    sample_to: new Date('2030-06-12T12:00:00+08:00'),
    sample_count: 0,
    sample_hash: 'unused',
    report: {},
    created_by: 'trialist',
    created_at: new Date('2030-06-12T12:00:00+08:00'),
  };
  const log: string[] = [];
  const db = await lockWaitingDb(
    (q) => {
      if (q.sql.includes('"commission_rule_trials"')) return [trial];
      if (q.sql.includes('"commission_rule_versions"')) return [first];
      return [];
    },
    clock,
    120_000,
    log,
  );
  const { deps: d, append } = deps(undefined, clock);
  await expectCode(
    db
      .transaction()
      .execute((tx) =>
        publish(
          tx,
          { appId: APP, actor: { adminUserId: 'p' }, draftId: 'draft', trialId: 't1' },
          d,
        ),
      ),
    'TRIAL_EXPIRED',
  );
  expect(log.findIndex((sql) => sql.endsWith('for update'))).toBeGreaterThanOrEqual(0);
  expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
  expect(append).not.toHaveBeenCalled();
});
