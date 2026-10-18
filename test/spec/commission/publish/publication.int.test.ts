// 仅覆盖 BR-CALC-05/06/07/11/22 与任务 §9；权限/step-up 留给路由任务。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type {
  CreateRuleDraftInput,
  RulePublicationErrorCode,
} from '../../../../apps/api/src/modules/commission/application/rule-publication.ts';
import {
  BASE_TIME,
  FUTURE,
  NOW,
  PLATFORMS,
  START,
  dependencies,
  draftInput,
  seedActor,
  seedSample,
  seedVersion,
  service,
  setup,
  stored,
} from './fixtures.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 60_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);
afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof setup>>;

async function trial(f: Fixture) {
  return db.transaction().execute((tx) => service.runTrial(tx, f.context, f.deps));
}

async function publish(f: Fixture, trialId: string) {
  return db.transaction().execute((tx) =>
    service.publish(
      tx,
      {
        ...f.context,
        trialId,
      },
      f.deps,
    ),
  );
}

async function rejectUnchanged(
  f: Fixture,
  code: RulePublicationErrorCode,
  action: () => Promise<unknown>,
) {
  const before = await stored(db, f.input.appId);
  const audits = f.append.mock.calls.length;
  await expect(action()).rejects.toMatchObject({ code });
  expect(await stored(db, f.input.appId)).toEqual(before);
  expect(f.append).toHaveBeenCalledTimes(audits);
}

it('[AC-B2-03k#1] BR-CALC-22 首版起草与草稿修改均追加，基准、行和审计完整留存', async () => {
  const input = draftInput({
    indirectEnabled: false,
    rules: draftInput().rules.map((r) => ({ ...r, r_indirect_bp: 0n })),
  });
  await seedActor(db, input);
  const f = dependencies();
  const transition = vi.spyOn(domain, 'transitionCommissionRuleVersion');
  const first = await db.transaction().execute((tx) => service.createDraft(tx, input, f.deps));
  const before = await stored(db, input.appId);
  const second = await db.transaction().execute((tx) =>
    service.createDraft(
      tx,
      {
        ...input,
        effectiveFrom: new Date('2030-06-14T12:00:00+08:00'),
        reserves: input.reserves.map((r) => ({ ...r, reserve_bp: 2000n })),
      },
      f.deps,
    ),
  );
  const after = await stored(db, input.appId);
  expect(first).toMatchObject({
    app_id: input.appId,
    status: 'draft',
    base_version_id: null,
    drafter_id: input.actor.adminUserId,
    publisher_id: null,
    effective_from: new Date(FUTURE),
    indirect_enabled: false,
    created_at: new Date(NOW),
  });
  expect(second.rule_version_id).not.toBe(first.rule_version_id);
  expect(second.effective_from).toEqual(new Date('2030-06-14T12:00:00+08:00'));
  expect(after.versions).toHaveLength(2);
  expect(after.versions.find((v) => v.rule_version_id === first.rule_version_id)).toEqual(first);
  expect(after.rules.filter((r) => r.rule_version_id === first.rule_version_id)).toEqual(
    before.rules,
  );
  expect(after.reserves.filter((r) => r.rule_version_id === first.rule_version_id)).toEqual(
    before.reserves,
  );
  expect(after.rules.filter((r) => r.rule_version_id === second.rule_version_id)).toHaveLength(18);
  expect(
    after.reserves
      .filter((r) => r.rule_version_id === second.rule_version_id)
      .map((r) => r.reserve_bp),
  ).toEqual([2000, 2000, 2000]);
  expect(transition).toHaveBeenCalledWith(null, 'DRAFT_CREATED');
  expect(f.append).toHaveBeenCalledTimes(2);
  expect(f.append).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: input.appId,
      actor: input.actor.adminUserId,
      action: 'commission.rule.draft',
      target: first.rule_version_id,
      before: null,
      after: expect.objectContaining({ status: 'draft' }),
    }),
  );
});

it('[AC-B2-03k#2] BR-CALC-22 起草保存当前基准且不改已有版本', async () => {
  const f = await setup(db);
  const before = await stored(db, f.input.appId);
  const draft = await db.transaction().execute((tx) => service.createDraft(tx, f.input, f.deps));
  const after = await stored(db, f.input.appId);
  expect(draft.base_version_id).toBe(f.baseId);
  expect(after.versions.filter((r) => r.rule_version_id !== draft.rule_version_id)).toEqual(
    before.versions,
  );
  expect(after.rules).toHaveLength(before.rules.length + 18);
  expect(after.reserves).toHaveLength(before.reserves.length + 3);
});

it('[AC-B2-03k#3] BR-CALC-06/07 校验原样返回领域结果且只读', async () => {
  const f = await setup(db);
  const validator = vi.spyOn(domain, 'validateRuleVersion');
  const before = await stored(db, f.input.appId);
  const result = await db.transaction().execute((tx) =>
    service.validateDraft(
      tx,
      {
        ...f.context,
      },
      f.deps,
    ),
  );
  expect(result).toEqual({ ok: true });
  expect(validator).toHaveBeenCalledWith(
    expect.objectContaining({
      draft: {
        indirect_enabled: true,
        effective_from: expect.stringMatching(/\+08:00$/),
        rules: expect.arrayContaining([...f.input.rules]),
        reserves: expect.arrayContaining([...f.input.reserves]),
      },
      platforms: PLATFORMS,
      publish_at: expect.stringMatching(/\+08:00$/),
      published_effective_froms: [expect.stringMatching(/\+08:00$/)],
    }),
  );
  const validated = validator.mock.calls.at(-1)![0];
  expect(new Date(validated.draft.effective_from)).toEqual(new Date(FUTURE));
  expect(new Date(validated.publish_at)).toEqual(new Date(NOW));
  expect(validated.published_effective_froms.map((value) => new Date(value))).toEqual([
    new Date(BASE_TIME),
  ]);
  expect(result).toBe(validator.mock.results.at(-1)?.value);
  expect(await stored(db, f.input.appId)).toEqual(before);
  expect(f.append).not.toHaveBeenCalled();
});

const invalidDrafts: {
  name: string;
  code: RulePublicationErrorCode;
  change: (input: CreateRuleDraftInput) => Partial<CreateRuleDraftInput>;
}[] = [
  {
    name: '缺 pdd/L2/self',
    code: 'MISSING_RULE',
    change: (i) => ({
      rules: i.rules.filter(
        (r) => !(r.platform === 'pdd' && r.level === 'L2' && r.order_type === 'self'),
      ),
    }),
  },
  {
    name: '缺 pdd 预留',
    code: 'MISSING_RESERVE',
    change: (i) => ({ reserves: i.reserves.filter((r) => r.platform !== 'pdd') }),
  },
  {
    name: '跨等级最大值之和 8100',
    code: 'TOTAL_RATIO_EXCEEDED',
    change: (i) => ({
      rules: i.rules.map((r) => ({
        ...r,
        r_own_bp: r.level === 'L3' ? 6500n : 1000n,
        r_direct_bp: r.level === 'L2' ? 1000n : 0n,
        r_indirect_bp: r.level === 'L1' ? 600n : 0n,
      })),
    }),
  },
  {
    name: '间推关闭仍有比例',
    code: 'INDIRECT_DISABLED',
    change: () => ({ indirectEnabled: false }),
  },
];

it.each(invalidDrafts)(
  '[AC-B2-03k#4] BR-CALC-05/06/07 $name 返回全部诊断，不生成试算报告',
  async ({ change, code }) => {
    const f = await setup(db, change(draftInput()));
    const expected = domain.validateRuleVersion({
      draft: {
        indirect_enabled: f.input.indirectEnabled,
        effective_from: FUTURE,
        rules: f.input.rules,
        reserves: f.input.reserves,
      },
      platforms: PLATFORMS,
      publish_at: NOW,
      published_effective_froms: [BASE_TIME],
    });
    const before = await stored(db, f.input.appId);
    const result = await db.transaction().execute((tx) =>
      service.validateDraft(
        tx,
        {
          ...f.context,
        },
        f.deps,
      ),
    );
    expect(result).toEqual(expected);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code })]),
    });
    expect(await stored(db, f.input.appId)).toEqual(before);
    await rejectUnchanged(f, code, () => trial(f));
  },
);

it('[AC-B2-03k#5] BR-CALC-06 新增配置平台必须补六行与预留，不能硬编码三个平台', async () => {
  const f = await setup(db);
  const result = await db.transaction().execute((tx) =>
    service.validateDraft(
      tx,
      {
        ...f.context,
      },
      { ...f.deps, platforms: [...PLATFORMS, 'meituan'] },
    ),
  );
  expect(result).toMatchObject({ ok: false });
  if (result.ok) throw new Error('Expected incomplete rules');
  expect(
    result.errors.filter((e) => e.code === 'MISSING_RULE' && e.platform === 'meituan'),
  ).toHaveLength(6);
  expect(
    result.errors.filter((e) => e.code === 'MISSING_RESERVE' && e.platform === 'meituan'),
  ).toHaveLength(1);
});

it('[AC-B2-03k#6] BR-CALC-07 跨等级上限等于 8000 可通过，预留不计入用户份额上限', async () => {
  const f = await setup(db, {
    rules: draftInput().rules.map((r) => ({
      ...r,
      r_own_bp: r.level === 'L3' ? 6500n : 5000n,
      r_direct_bp: r.level === 'L2' ? 1000n : 0n,
      r_indirect_bp: r.level === 'L1' ? 500n : 0n,
    })),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 10000n })),
  });
  expect(
    await db.transaction().execute((tx) =>
      service.validateDraft(
        tx,
        {
          ...f.context,
        },
        f.deps,
      ),
    ),
  ).toEqual({ ok: true });
});

it('[AC-B2-03k#7] BR-CALC-22 试算只取七天左闭右开且有快照的本 app 样本，按各角色等级算列', async () => {
  const f = await setup(db, {
    rules: draftInput().rules.map((r) => ({
      ...r,
      r_own_bp: 4500n,
      r_direct_bp: r.level === 'L2' ? 1200n : 100n,
      r_indirect_bp: r.level === 'L3' ? 700n : 100n,
    })),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 2000n })),
  });
  await seedSample(db, f.input, f.baseId, { paidAt: START });
  await seedSample(db, f.input, f.baseId, {
    paidAt: '2030-06-12T11:59:59+08:00',
    platform: 'jd',
    orderType: 'share',
  });
  await seedSample(db, f.input, f.baseId, { paidAt: '2030-06-05T11:59:59+08:00' });
  await seedSample(db, f.input, f.baseId, { paidAt: NOW });
  await seedSample(db, f.input, f.baseId, { snapshot: false });
  const other = await setup(db);
  await seedSample(db, other.input, other.baseId);
  const before = await stored(db, f.input.appId);
  const report = await trial(f);
  expect(report).toMatchObject({
    sampleFrom: new Date(START),
    sampleTo: new Date(NOW),
    sampleCount: 2,
  });
  expect(report.sampleHash).toEqual(expect.stringMatching(/\S+/));
  expect(report.report.platforms).toHaveLength(3);
  for (const platform of ['taobao', 'jd'])
    expect(report.report.platforms).toContainEqual({
      platform,
      current: {
        reserveBp: 1000,
        reserveFen: 124,
        ownFen: 555,
        directFen: 111,
        indirectFen: 55,
        platformRetainFen: 389,
      },
      draft: {
        reserveBp: 2000,
        reserveFen: 247,
        ownFen: 444,
        directFen: 118,
        indirectFen: 69,
        platformRetainFen: 356,
      },
    });
  expect(report.report.platforms).toContainEqual({
    platform: 'pdd',
    current: {
      reserveBp: 1000,
      reserveFen: 0,
      ownFen: 0,
      directFen: 0,
      indirectFen: 0,
      platformRetainFen: 0,
    },
    draft: {
      reserveBp: 2000,
      reserveFen: 0,
      ownFen: 0,
      directFen: 0,
      indirectFen: 0,
      platformRetainFen: 0,
    },
  });
  const after = await stored(db, f.input.appId);
  expect(after.trials).toEqual([
    expect.objectContaining({
      trial_id: report.trialId,
      app_id: f.input.appId,
      rule_version_id: f.draftId,
      base_version_id: f.baseId,
      sample_from: new Date(START),
      sample_to: new Date(NOW),
      sample_count: 2,
      sample_hash: report.sampleHash,
      report: report.report,
      created_by: f.input.actor.adminUserId,
      created_at: new Date(NOW),
    }),
  ]);
  expect({ ...after, trials: [] }).toEqual(before);
  expect(f.append).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      appId: f.input.appId,
      actor: f.input.actor.adminUserId,
      action: 'commission.rule.trial',
      target: report.trialId,
      before: null,
      after: expect.any(Object),
    }),
  );
});

it('[AC-B2-03k#8] BR-CALC-05 关闭间推试算仍明确返回零间推列', async () => {
  const f = await setup(db, {
    indirectEnabled: false,
    rules: draftInput().rules.map((r) => ({ ...r, r_indirect_bp: 0n })),
  });
  await seedSample(db, f.input, f.baseId);
  const result = await trial(f);
  expect(result.report.platforms.find((p) => p.platform === 'taobao')).toMatchObject({
    current: { indirectFen: 55 },
    draft: { indirectFen: 0, platformRetainFen: 444 },
  });
});

it('[AC-B2-03k#9] BR-CALC-22 相同样本摘要稳定，每次试算新增报告保留旧报告', async () => {
  const f = await setup(db);
  await seedSample(db, f.input, f.baseId);
  const first = await trial(f);
  const saved = (await stored(db, f.input.appId)).trials;
  const second = await trial(f);
  expect(second.trialId).not.toBe(first.trialId);
  expect(second.sampleHash).toBe(first.sampleHash);
  expect(second.report).toEqual(first.report);
  const rows = (await stored(db, f.input.appId)).trials;
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.trial_id === first.trialId)).toEqual(saved[0]);
});

it('[AC-B2-03k#10] BR-CALC-22 空样本与首版可完成试算和发布', async () => {
  const input = draftInput();
  await seedActor(db, input);
  const f = dependencies();
  const draftId = await seedVersion(db, input);
  const context = { appId: input.appId, actor: input.actor, draftId };
  const result = await db.transaction().execute((tx) => service.runTrial(tx, context, f.deps));
  expect(result.sampleCount).toBe(0);
  expect(result.report.platforms).toHaveLength(3);
  for (const row of result.report.platforms)
    expect(row).toMatchObject({
      current: null,
      draft: { reserveFen: 0, ownFen: 0, directFen: 0, indirectFen: 0, platformRetainFen: 0 },
    });
  const published = await db.transaction().execute((tx) =>
    service.publish(
      tx,
      {
        ...context,
        trialId: result.trialId,
      },
      f.deps,
    ),
  );
  expect(published.status).toBe('published');
});

it('[AC-B2-03k#11] BR-CALC-22 试算金额溢出 JSON 安全整数不能生成报告或发布', async () => {
  const f = await setup(db);
  await seedSample(db, f.input, f.baseId, { n: 9223372036854775807n });
  await rejectUnchanged(f, 'TRIAL_FAILED', () => trial(f));
  await rejectUnchanged(f, 'TRIAL_NOT_FOUND', () => publish(f, randomUUID()));
});

it.each([500n, 1500n])(
  '[AC-B2-03k#12] BR-CALC-11/22 预留调整至 %s 可同人立即发布，历史快照不回溯',
  async (reserveBp) => {
    const f = await setup(db, {
      effectiveFrom: new Date(NOW),
      reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: reserveBp })),
    });
    await seedSample(db, f.input, f.baseId);
    const report = await trial(f);
    const before = await stored(db, f.input.appId);
    const transition = vi.spyOn(domain, 'transitionCommissionRuleVersion');
    const result = await publish(f, report.trialId);
    expect(result).toMatchObject({
      rule_version_id: f.draftId,
      status: 'published',
      drafter_id: f.input.actor.adminUserId,
      publisher_id: f.input.actor.adminUserId,
      published_at: new Date(NOW),
      effective_from: new Date(NOW),
      indirect_approver_id: null,
      indirect_approved_at: null,
    });
    expect(transition).toHaveBeenCalledWith('draft', 'PUBLISH');
    const after = await stored(db, f.input.appId);
    expect(after).toEqual({
      ...before,
      versions: before.versions.map((v) =>
        v.rule_version_id === f.draftId
          ? {
              ...v,
              status: 'published',
              publisher_id: f.input.actor.adminUserId,
              published_at: new Date(NOW),
            }
          : v,
      ),
    });
    expect(f.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: f.input.appId,
        actor: f.input.actor.adminUserId,
        action: 'commission.rule.publish',
        target: f.draftId,
        before: expect.objectContaining({ status: 'draft' }),
        after: expect.objectContaining({ status: 'published' }),
      }),
    );
  },
);

it('[AC-B2-03k#13] BR-CALC-11 草稿原本可立即生效，但发布时已早一秒则零写入拒绝', async () => {
  const f = await setup(db, { effectiveFrom: new Date(NOW) });
  const report = await trial(f);
  f.clock.advanceMs(1000);
  await rejectUnchanged(f, 'EFFECTIVE_BEFORE_PUBLISH', () => publish(f, report.trialId));
  await rejectUnchanged(f, 'EFFECTIVE_BEFORE_PUBLISH', () => trial(f));
});

it.each(['2030-06-13T11:59:59+08:00', FUTURE, '2030-06-13T12:00:00.999+08:00'])(
  '[AC-B2-03k#14] BR-CALC-11 生效时刻 %s 未严格超过未来已发布版也拒绝',
  async (effective) => {
    const f = await setup(db, { effectiveFrom: new Date('2030-06-14T12:00:00+08:00') });
    const latest = await seedVersion(db, f.input, { status: 'published', effective: FUTURE });
    const draftId = await seedVersion(db, { ...f.input, baseVersionId: latest });
    f.context.draftId = draftId;
    const report = await trial(f);
    // 独立构造已有报告：同样内容、基准与空样本，所属草稿的时间不合法。
    // 即便已有试算证据，发布仍必须重新检查草稿自带时间。
    f.context.draftId = await seedVersion(db, {
      ...f.input,
      baseVersionId: latest,
      effectiveFrom: new Date(effective),
    });
    const saved = (await stored(db, f.input.appId)).trials.find(
      (r) => r.trial_id === report.trialId,
    )!;
    const trialId = randomUUID();
    await db
      .withSchema('app')
      .insertInto('commission_rule_trials')
      .values({
        ...saved,
        trial_id: trialId,
        rule_version_id: f.context.draftId,
      })
      .execute();
    await rejectUnchanged(f, 'EFFECTIVE_NOT_INCREASING', () => publish(f, trialId));
  },
);

it('[AC-B2-03k#15] BR-CALC-11 已撤销的未来版不阻挡立即生效', async () => {
  const f = await setup(db, { effectiveFrom: new Date(NOW) });
  await seedVersion(db, f.input, { status: 'revoked', effective: FUTURE });
  const report = await trial(f);
  expect((await publish(f, report.trialId)).status).toBe('published');
});

it('[AC-B2-03k#16] BR-CALC-22 基准已变化不能发布旧草稿', async () => {
  const f = await setup(db);
  const report = await trial(f);
  await seedVersion(db, f.input, { status: 'published', effective: NOW });
  await rejectUnchanged(f, 'BASE_VERSION_MISMATCH', () => publish(f, report.trialId));
});

it('[AC-B2-03k#17] BR-CALC-22 缺试算报告不得发布', async () => {
  const f = await setup(db);
  await rejectUnchanged(f, 'TRIAL_NOT_FOUND', () => publish(f, randomUUID()));
});

it('[AC-B2-03k#18] BR-CALC-22 同 app 另一个草稿的试算不能借用', async () => {
  const f = await setup(db);
  const report = await trial(f);
  f.context.draftId = await seedVersion(db, f.input);
  await rejectUnchanged(f, 'TRIAL_DRAFT_MISMATCH', () => publish(f, report.trialId));
});

it.each([599_000, 600_000])(
  '[AC-B2-03k#19] BR-CALC-22 试算年龄 %s 毫秒有效，重新计算原窗口而非滚动窗口',
  async (age) => {
    const f = await setup(db);
    await seedSample(db, f.input, f.baseId, { paidAt: START });
    const report = await trial(f);
    f.clock.advanceMs(age);
    await seedSample(db, f.input, f.baseId, { paidAt: '2030-06-12T12:01:00+08:00' });
    expect((await publish(f, report.trialId)).status).toBe('published');
  },
);

it.each([600_001, -1000])(
  '[AC-B2-03k#20] BR-CALC-22 超十分钟或未来试算（年龄 %s）拒绝',
  async (age) => {
    const f = await setup(db);
    const report = await trial(f);
    f.clock.advanceMs(age);
    await rejectUnchanged(f, 'TRIAL_EXPIRED', () => publish(f, report.trialId));
  },
);

it('[AC-B2-03k#21] BR-CALC-22 窗口内迟到的新快照使样本漂移，重跑后可发布', async () => {
  const f = await setup(db);
  const report = await trial(f);
  await seedSample(db, f.input, f.baseId);
  await rejectUnchanged(f, 'TRIAL_SAMPLE_CHANGED', () => publish(f, report.trialId));
  const refreshed = await trial(f);
  expect(refreshed.sampleHash).not.toBe(report.sampleHash);
  expect((await publish(f, refreshed.trialId)).status).toBe('published');
});

it('[AC-B2-03k#22] BR-CALC-22 订单集不变但快照金额版本追加也必须使摘要变化', async () => {
  const f = await setup(db);
  const orderId = await seedSample(db, f.input, f.baseId);
  const report = await trial(f);
  const amount = (await stored(db, f.input.appId)).amounts.find((r) => r.order_id === orderId)!;
  await db
    .withSchema('app')
    .insertInto('commission_split_amounts')
    .values({
      ...amount,
      commission_version: 2,
      amount_fen: 1n,
    })
    .execute();
  await rejectUnchanged(f, 'TRIAL_SAMPLE_CHANGED', () => publish(f, report.trialId));
  const refreshed = await trial(f);
  expect(refreshed.sampleCount).toBe(report.sampleCount);
  expect(refreshed.sampleHash).not.toBe(report.sampleHash);
});

it('[AC-B2-03k#23] BR-CALC-11 生效前一秒可撤销且只变状态与撤销时间', async () => {
  const f = await setup(db);
  const versionId = await seedVersion(db, f.input, { status: 'published', effective: FUTURE });
  f.clock.set('2030-06-13T11:59:59+08:00');
  const before = await stored(db, f.input.appId);
  const transition = vi.spyOn(domain, 'transitionCommissionRuleVersion');
  const result = await db.transaction().execute((tx) =>
    service.revoke(
      tx,
      {
        ...f.context,
        versionId,
      },
      f.deps,
    ),
  );
  expect(result).toMatchObject({ status: 'revoked', revoked_at: f.clock.now() });
  expect(transition).toHaveBeenCalledWith('published', 'REVOKE');
  const after = await stored(db, f.input.appId);
  expect(after).toEqual({
    ...before,
    versions: before.versions.map((r) =>
      r.rule_version_id === versionId ? { ...r, status: 'revoked', revoked_at: f.clock.now() } : r,
    ),
  });
  expect(f.append).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      appId: f.input.appId,
      actor: f.input.actor.adminUserId,
      action: 'commission.rule.revoke',
      target: versionId,
      before: expect.objectContaining({ status: 'published' }),
      after: expect.objectContaining({ status: 'revoked' }),
    }),
  );
});

it.each([FUTURE, '2030-06-13T12:00:01+08:00'])(
  '[AC-B2-03k#24] BR-CALC-11 到点/已生效（%s）不可撤销',
  async (now) => {
    const f = await setup(db);
    const versionId = await seedVersion(db, f.input, { status: 'published', effective: FUTURE });
    f.clock.set(now);
    await rejectUnchanged(f, 'VERSION_ALREADY_EFFECTIVE', () =>
      db.transaction().execute((tx) => service.revoke(tx, { ...f.context, versionId }, f.deps)),
    );
  },
);

it.each(['draft', 'revoked'] as const)(
  '[AC-B2-03k#25] BR-CALC-11/22 %s 不能撤销',
  async (status) => {
    const f = await setup(db);
    const versionId = await seedVersion(db, f.input, { status, effective: FUTURE });
    await rejectUnchanged(f, 'ILLEGAL_TRANSITION', () =>
      db.transaction().execute((tx) => service.revoke(tx, { ...f.context, versionId }, f.deps)),
    );
  },
);

it.each(['published', 'revoked'] as const)(
  '[AC-B2-03k#26] BR-CALC-22 %s 不得重新发布或试算修改',
  async (status) => {
    const f = await setup(db);
    const report = await trial(f);
    f.context.draftId = await seedVersion(db, f.input, { status, effective: FUTURE });
    await rejectUnchanged(f, 'ILLEGAL_TRANSITION', () => publish(f, report.trialId));
    await rejectUnchanged(f, 'ILLEGAL_TRANSITION', () => trial(f));
  },
);

it('[AC-B2-03k#27] BR-CALC-22 重复发布不能重复迁移或增加成功审计', async () => {
  const f = await setup(db);
  const report = await trial(f);
  await publish(f, report.trialId);
  await rejectUnchanged(f, 'ILLEGAL_TRANSITION', () => publish(f, report.trialId));
});

it('[AC-B2-03k#28] BR-CALC-22 跨 app 版本不可读取、试算、发布、撤销或作为基准', async () => {
  const f = await setup(db);
  const other = await setup(db);
  const otherBefore = await stored(db, other.input.appId);
  f.context.draftId = other.draftId;
  await rejectUnchanged(f, 'VERSION_NOT_FOUND', () =>
    db.transaction().execute((tx) => service.validateDraft(tx, f.context, f.deps)),
  );
  await rejectUnchanged(f, 'VERSION_NOT_FOUND', () => trial(f));
  await rejectUnchanged(f, 'VERSION_NOT_FOUND', () => publish(f, randomUUID()));
  await rejectUnchanged(f, 'VERSION_NOT_FOUND', () =>
    db
      .transaction()
      .execute((tx) => service.revoke(tx, { ...f.context, versionId: other.baseId }, f.deps)),
  );
  await rejectUnchanged(f, 'VERSION_NOT_FOUND', () =>
    db
      .transaction()
      .execute((tx) =>
        service.createDraft(tx, { ...f.input, baseVersionId: other.baseId }, f.deps),
      ),
  );
  expect(await stored(db, other.input.appId)).toEqual(otherBefore);
});

it('[AC-B2-03k#29] BR-CALC-22 跨 app 试算报告不可借用', async () => {
  const f = await setup(db);
  const other = await setup(db);
  const report = await trial(other);
  await rejectUnchanged(f, 'TRIAL_NOT_FOUND', () => publish(f, report.trialId));
});

it('[AC-B2-03k#30] BR-CALC-11/22 两草稿同基准并发发布，只有一个成功且下一版严格递增', async () => {
  const f = await setup(db);
  const secondId = await seedVersion(db, f.input, { effective: '2030-06-14T12:00:00+08:00' });
  const second = { ...f, context: { ...f.context, draftId: secondId } };
  const [a, b] = await Promise.all([trial(f), trial(second)]);
  // 故意不同生效时刻：仅靠 (app_id, effective_from) 唯一索引不足以挡住竞态。
  const outcomes = await Promise.allSettled([publish(f, a.trialId), publish(second, b.trialId)]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((r) => r.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining({ code: 'BASE_VERSION_MISMATCH' }) }),
  ]);
  const rows = (await stored(db, f.input.appId)).versions;
  expect(rows.filter((r) => r.status === 'published')).toHaveLength(2);
  expect(rows.filter((r) => r.status === 'draft')).toHaveLength(1);
  const winner = rows.find((r) => r.status === 'published' && r.rule_version_id !== f.baseId)!;
  const nextId = await seedVersion(db, {
    ...f.input,
    baseVersionId: winner.rule_version_id,
    effectiveFrom: new Date('2030-06-15T12:00:00+08:00'),
  });
  const next = { ...f, context: { ...f.context, draftId: nextId } };
  const c = await trial(next);
  const last = await publish(next, c.trialId);
  expect(last.effective_from!.getTime()).toBeGreaterThan(winner.effective_from!.getTime());
  expect(
    f.append.mock.calls.filter(([event]) => event.action === 'commission.rule.publish'),
  ).toHaveLength(2);
});

it('[AC-B2-03k#31] BR-CALC-22 调用方事务回滚撤销发布的全部数据库写入', async () => {
  const f = await setup(db);
  const report = await trial(f);
  const before = await stored(db, f.input.appId);
  const abort = new Error('synthetic caller rollback');
  await expect(
    db.transaction().execute(async (tx) => {
      await service.publish(tx, { ...f.context, trialId: report.trialId }, f.deps);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await stored(db, f.input.appId)).toEqual(before);
});

it('[AC-B2-03k#32] BR-CALC-22 审计失败使起草写入随调用方事务回滚', async () => {
  const f = await setup(db);
  const before = await stored(db, f.input.appId);
  const failure = new Error('synthetic audit unavailable');
  f.append.mockRejectedValueOnce(failure);
  await expect(
    db.transaction().execute((tx) => service.createDraft(tx, f.input, f.deps)),
  ).rejects.toBe(failure);
  expect(await stored(db, f.input.appId)).toEqual(before);
});

/** 事务已完成用例但暂不提交，让第二连接用 NOWAIT 实测锁仍被持有。 */
async function withHeldTransaction(
  action: (tx: Transaction<DB>) => Promise<unknown>,
  inspect: () => Promise<void>,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = db.transaction().execute(async (tx) => {
    await action(tx);
    entered.resolve();
    await release.promise;
  });
  // 骨架失败直接传给测试，不能挂起等待闩锁。
  void job.catch((error: unknown) => entered.reject(error));
  try {
    await entered.promise;
    await inspect();
  } finally {
    release.resolve();
    await job;
  }
}

it('[AC-B2-03k#33] BR-CALC-11/22 发布锁整个本 app 版本集合，与快照 FOR SHARE 互斥至提交', async () => {
  const f = await setup(db);
  const other = await setup(db);
  const report = await trial(f);
  await withHeldTransaction(
    (tx) => service.publish(tx, { ...f.context, trialId: report.trialId }, f.deps),
    async () => {
      // 锁旧基准行，不仅仅锁被 UPDATE 的草稿；不会被普通 UPDATE 的锁误满足。
      await expect(
        db
          .transaction()
          .execute((tx) =>
            tx
              .withSchema('app')
              .selectFrom('commission_rule_versions')
              .select('rule_version_id')
              .where('app_id', '=', f.input.appId)
              .where('rule_version_id', '=', f.baseId)
              .forShare()
              .noWait()
              .execute(),
          ),
      ).rejects.toMatchObject({ code: '55P03' });
      const rows = await db
        .transaction()
        .execute((tx) =>
          tx
            .withSchema('app')
            .selectFrom('commission_rule_versions')
            .select('rule_version_id')
            .where('app_id', '=', other.input.appId)
            .forUpdate()
            .noWait()
            .execute(),
        );
      expect(rows).toHaveLength(2);
    },
  );
});

it('[AC-B2-03k#34] BR-CALC-11 快照 FOR SHARE 在先时发布不能绕过行锁', async () => {
  const f = await setup(db);
  const report = await trial(f);
  await withHeldTransaction(
    (tx) =>
      tx
        .withSchema('app')
        .selectFrom('commission_rule_versions')
        .select('rule_version_id')
        .where('app_id', '=', f.input.appId)
        .where('rule_version_id', '=', f.baseId)
        .forShare()
        .execute(),
    async () => {
      await expect(
        db.transaction().execute(async (tx) => {
          await sql`set local lock_timeout = '200ms'`.execute(tx);
          return service.publish(tx, { ...f.context, trialId: report.trialId }, f.deps);
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    },
  );
});

it('[AC-B2-03k#35] BR-CALC-11 撤销锁与快照 FOR SHARE 互斥至提交', async () => {
  const f = await setup(db);
  const versionId = await seedVersion(db, f.input, { status: 'published', effective: FUTURE });
  await withHeldTransaction(
    (tx) => service.revoke(tx, { ...f.context, versionId }, f.deps),
    async () => {
      await expect(
        db
          .transaction()
          .execute((tx) =>
            tx
              .withSchema('app')
              .selectFrom('commission_rule_versions')
              .select('rule_version_id')
              .where('app_id', '=', f.input.appId)
              .where('rule_version_id', '=', versionId)
              .forShare()
              .noWait()
              .execute(),
          ),
      ).rejects.toMatchObject({ code: '55P03' });
    },
  );
});

it.each([
  { field: 'r_own_bp', value: -1n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'r_own_bp', value: 8001n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'r_direct_bp', value: -1n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'r_direct_bp', value: 8001n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'r_indirect_bp', value: -1n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'r_indirect_bp', value: 8001n, code: 'RATIO_OUT_OF_RANGE' },
  { field: 'reserve_bp', value: -1n, code: 'RESERVE_OUT_OF_RANGE' },
  { field: 'reserve_bp', value: 10001n, code: 'RESERVE_OUT_OF_RANGE' },
] as const)(
  '[AC-B2-03k#36] BR-CALC-06/07 非法 $field=$value 起草失败，不能遗留版本头或部分行',
  async ({ field, value, code }) => {
    const f = await setup(db);
    const input =
      field === 'reserve_bp'
        ? { ...f.input, reserves: f.input.reserves.map((r) => ({ ...r, reserve_bp: value })) }
        : { ...f.input, rules: f.input.rules.map((r) => ({ ...r, [field]: value })) };
    await rejectUnchanged(f, code, () =>
      db.transaction().execute((tx) => service.createDraft(tx, input, f.deps)),
    );
  },
);

it('[AC-B2-03k#37] BR-CALC-06/07 有报告的草稿发布时仍须重新调用领域校验器', async () => {
  const f = await setup(db);
  const report = await trial(f);
  // 模拟发布时配置扩展，而不是篡改已留存的草稿/报告。
  const deps = { ...f.deps, platforms: [...PLATFORMS, 'meituan'] };
  const validator = vi.spyOn(domain, 'validateRuleVersion');
  await rejectUnchanged(f, 'MISSING_RULE', () =>
    db
      .transaction()
      .execute((tx) => service.publish(tx, { ...f.context, trialId: report.trialId }, deps)),
  );
  expect(validator).toHaveBeenCalledWith(expect.objectContaining({ platforms: deps.platforms }));
});

it('[AC-B2-03k#38] BR-CALC-11 时间按秒比较：同秒较早毫秒允许立即生效', async () => {
  const f = await setup(db, { effectiveFrom: new Date('2030-06-12T12:00:00.001+08:00') });
  const report = await trial(f);
  f.clock.set('2030-06-12T12:00:00.999+08:00');
  const result = await publish(f, report.trialId);
  expect(result.status).toBe('published');
  expect(result.published_at).toEqual(f.clock.now());
});

it('[AC-B2-03k#39] BR-CALC-11 同秒不可撤销，即使生效时间的毫秒还没到', async () => {
  const f = await setup(db);
  const versionId = await seedVersion(db, f.input, {
    status: 'published',
    effective: '2030-06-13T12:00:00.999+08:00',
  });
  f.clock.set('2030-06-13T12:00:00.001+08:00');
  await rejectUnchanged(f, 'VERSION_ALREADY_EFFECTIVE', () =>
    db.transaction().execute((tx) => service.revoke(tx, { ...f.context, versionId }, f.deps)),
  );
});

it('[AC-B2-03k#40] BR-CALC-22 其他 app 的新版本与新快照不影响本 app 基准或摘要', async () => {
  const f = await setup(db);
  await seedSample(db, f.input, f.baseId);
  const report = await trial(f);
  const other = await setup(db);
  await seedVersion(db, other.input, { status: 'published', effective: FUTURE });
  await seedSample(db, other.input, other.baseId);
  expect((await publish(f, report.trialId)).status).toBe('published');
});

it.each(['draft', 'trial', 'publish', 'revoke'] as const)(
  '[AC-B2-03k#41] BR-CALC-22 %s 状态只使用生成 transition 的合法结果',
  async (operation) => {
    const f = await setup(db);
    const report = operation === 'publish' ? await trial(f) : null;
    const versionId =
      operation === 'revoke'
        ? await seedVersion(db, f.input, { status: 'published', effective: FUTURE })
        : f.draftId;
    if (operation === 'trial') {
      // 试算不改变版本状态。
      const before = (await stored(db, f.input.appId)).versions;
      await trial(f);
      expect((await stored(db, f.input.appId)).versions).toEqual(before);
    } else {
      const transition = vi
        .spyOn(domain, 'transitionCommissionRuleVersion')
        .mockReturnValue({ ok: false, reason: 'illegal', id: null });
      await rejectUnchanged(f, 'ILLEGAL_TRANSITION', () =>
        db.transaction().execute((tx) => {
          if (operation === 'draft') return service.createDraft(tx, f.input, f.deps);
          if (operation === 'publish')
            return service.publish(tx, { ...f.context, trialId: report!.trialId }, f.deps);
          return service.revoke(tx, { ...f.context, versionId }, f.deps);
        }),
      );
      expect(transition).toHaveBeenCalled();
    }
  },
);

it('[AC-B2-03k#42] BR-CALC-22 现行列按基准版重算，不能直接照抄历史快照金额', async () => {
  const f = await setup(db);
  await seedSample(db, f.input, f.baseId);
  const currentInput = {
    ...f.input,
    rules: f.input.rules.map((r) => ({ ...r, r_own_bp: 4000n })),
  };
  const currentId = await seedVersion(db, currentInput, {
    status: 'published',
    effective: '2030-06-10T00:00:00+08:00',
  });
  f.context.draftId = await seedVersion(db, { ...f.input, baseVersionId: currentId });
  const before = await stored(db, f.input.appId);
  const report = await trial(f);
  expect(report.report.platforms.find((p) => p.platform === 'taobao')).toEqual({
    platform: 'taobao',
    current: {
      reserveBp: 1000,
      reserveFen: 124,
      ownFen: 444,
      directFen: 111,
      indirectFen: 55,
      platformRetainFen: 500,
    },
    draft: {
      reserveBp: 1000,
      reserveFen: 124,
      ownFen: 555,
      directFen: 111,
      indirectFen: 55,
      platformRetainFen: 389,
    },
  });
  const after = await stored(db, f.input.appId);
  expect(after.splits).toEqual(before.splits);
  expect(after.amounts).toEqual(before.amounts);
  expect(after.trials[0]?.base_version_id).toBe(currentId);
});

it('[AC-B2-03k#43] BR-CALC-11 起草的 Date 非法时返回模块诊断且零写入', async () => {
  const f = await setup(db);
  await rejectUnchanged(f, 'INVALID_EFFECTIVE_FROM', () =>
    db.transaction().execute((tx) =>
      service.createDraft(
        tx,
        {
          ...f.input,
          effectiveFrom: new Date(Number.NaN),
        },
        f.deps,
      ),
    ),
  );
});

it('[AC-B2-03k#44] BR-CALC-11/22 修改生效时间须另建草稿并重新试算，旧草稿与报告留存', async () => {
  const f = await setup(db);
  const report = await trial(f);
  const before = await stored(db, f.input.appId);
  const replacement = await db.transaction().execute((tx) =>
    service.createDraft(
      tx,
      {
        ...f.input,
        effectiveFrom: new Date('2030-06-14T12:00:00+08:00'),
      },
      f.deps,
    ),
  );
  const after = await stored(db, f.input.appId);
  expect(after.versions.filter((v) => v.rule_version_id !== replacement.rule_version_id)).toEqual(
    before.versions,
  );
  expect(after.trials).toEqual(before.trials);
  const next = { ...f, context: { ...f.context, draftId: replacement.rule_version_id } };
  await rejectUnchanged(next, 'TRIAL_DRAFT_MISMATCH', () => publish(next, report.trialId));
  const refreshed = await trial(next);
  const result = await publish(next, refreshed.trialId);
  expect(result.effective_from).toEqual(replacement.effective_from);
  expect(result.status).toBe('published');
});
