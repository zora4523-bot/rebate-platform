// B2-09f access rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml, the
// five writes of CT-24zd — order of checks settle.bill (10403 data.reason=admin_permission_denied;
// fund.view alone is not enough; a super admin holds every point) → step-up tier totp (10003
// data.tier=totp) → body → the id (unknown / another app → 20001 data.fields naming it, no 404).
// A body the route schema refuses is answered before the guard runs (platform validation), so the
// order is pinned with bodies the schema lets through and only the use case refuses. Every refusal
// changes nothing and writes no audit record. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BILL,
  VIEW,
  answer,
  audits,
  conflict,
  creditSwitch,
  denied,
  everything,
  expected,
  fixture,
  later,
  newKey,
  refused,
  seedBatch,
  seedBill,
  setSwitch,
  stepUpRequired,
  suite,
  versionOf,
  withCommandsAdmin,
  type AdminSent,
  type CommandOptions,
  type CommandsAdmin,
  type Fixture,
} from './kit.ts';

const s = suite();

interface Op {
  readonly name: string;
  /** A request that succeeds for an authorised, stepped-up caller. */
  send(h: CommandsAdmin, options?: CommandOptions): Promise<AdminSent>;
  /** A request the schema lets through and the use case refuses: permission and step-up go first. */
  invalid(h: CommandsAdmin, options?: CommandOptions): Promise<AdminSent>;
}

/** One target per operation, each on a bill of its own, all five ready to succeed. */
async function operations(f: Fixture): Promise<Op[]> {
  await setSwitch(f, creditSwitch('taobao'), true);
  const draftBill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, draftBill);
  const scheduled = await seedBatch(f, await seedBill(f, '2026-08'), {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    row_version: 1,
  });
  const rejectable = await seedBatch(f, await seedBill(f, '2026-07'), { row_version: 2 });
  const partial = await seedBatch(f, await seedBill(f, '2026-06'), {
    status: 'PARTIAL',
    row_version: 3,
  });
  const empty = await seedBill(f, '2026-05');
  return [
    {
      name: 'confirm',
      send: (h, o) => h.confirm(draftBill.bill_id, { expected_batches: expected([draft]) }, o),
      invalid: (h, o) =>
        h.confirm(
          draftBill.bill_id,
          {
            expected_batches: expected([draft]),
            settle_mode: 'IMMEDIATE',
            scheduled_at: later(f, 60).toISOString(),
          },
          o,
        ),
    },
    {
      name: 'cancelSchedule',
      send: (h, o) => h.cancelSchedule(scheduled.batch_id, versionOf(scheduled), o),
      invalid: (h, o) => h.cancelSchedule(randomUUID(), versionOf(scheduled), o),
    },
    {
      name: 'reject',
      send: (h, o) =>
        h.reject(rejectable.batch_id, { ...versionOf(rejectable), reason: '联盟数据待核对' }, o),
      invalid: (h, o) =>
        h.reject(rejectable.batch_id, { ...versionOf(rejectable), reason: '   ' }, o),
    },
    {
      name: 'resume',
      send: (h, o) => h.resume(partial.batch_id, versionOf(partial), o),
      invalid: (h, o) => h.resume(randomUUID(), versionOf(partial), o),
    },
    {
      name: 'supplement',
      send: (h, o) => h.supplement(empty.bill_id, { platform: 'taobao' }, o),
      invalid: (h, o) => h.supplement('2020-01', { platform: 'taobao' }, o),
    },
  ];
}

it('[AC-B2-09f#3] 五个写接口的权限：只有 settle.bill（或超管）能写；只有 fund.view、没有权限点、只有别的权限点 → 10403 data.reason=admin_permission_denied（先于二次验证、请求体与 id 检查）；不带令牌 → 10001；被拒时什么都不变、不写审计', async () => {
  const f = fixture(s);
  const ops = await operations(f);
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['settle.statement_upload', 'fund.recon', 'fund.settle_adjust']),
    ];
    for (const op of ops) {
      for (const caller of outsiders) {
        await denied(await op.send(h, { caller }));
        await denied(await op.invalid(h, { caller, stepUp: null }));
      }
      await answer(await op.send(h, { caller: null }), 10001);
    }
    expect(await everything(f)).toEqual(before);

    const root = await h.caller([], { superAdmin: true });
    for (const op of ops) await answer(await op.send(h, { caller: root }), 0);
  });
});

it('[AC-B2-09f#4] 只有 settle.bill 而没有 fund.view 也能写（写不要求读点）；两点都有的账号同样能写', async () => {
  const f = fixture(s);
  const ops = await operations(f);
  await withCommandsAdmin(f, async (h) => {
    const both = await h.caller([BILL, VIEW]);
    for (const [index, op] of ops.entries()) {
      await answer(await op.send(h, { caller: index % 2 === 0 ? h.biller : both }), 0);
    }
  });
});

it('[AC-B2-09f#5] 二次验证（totp 档）：不带 X-Step-Up-Token、令牌是别的账号的、令牌是 sms 档的 → 10003 data.tier=totp，先于请求体与 id 检查；什么都不变；成功后令牌已消费，再用 → 10003；发起补充在 10003 之后用同一 Idempotency-Key 重放即成功', async () => {
  const f = fixture(s);
  const ops = await operations(f);
  await withCommandsAdmin(f, async (h) => {
    const colleague = await h.caller([BILL]);
    const before = await everything(f);
    const key = newKey();
    for (const op of ops) {
      await stepUpRequired(await op.send(h, { key, stepUp: null }));
      await stepUpRequired(await op.send(h, { key, stepUp: await h.stepUp(colleague) }));
      await stepUpRequired(await op.send(h, { key, stepUp: await h.stepUp(h.biller, 'sms') }));
      await stepUpRequired(await op.invalid(h, { stepUp: null }));
    }
    expect(await everything(f)).toEqual(before);

    for (const op of ops) {
      const token = await h.stepUp(h.biller);
      await answer(await op.send(h, { key, stepUp: token }), 0);
      await stepUpRequired(await op.invalid(h, { stepUp: token }));
    }
  });
});

it('[AC-B2-09f#6] 应用隔离：别的应用的批次当不存在（cancel-schedule、reject、resume → 20001 data.fields=[batch_id]，与不存在的 id、不是 UUID 的 id 应答一样，不回 404）；只有别的应用有的账单月 → confirm、发起补充 20001 [bill_id]；expected_batches 夹带别的应用的批次 → 20902；两边都不变；同月份本应用的确认不碰别的应用的 DRAFT', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await setSwitch(f, creditSwitch('taobao'), true);
  const own = await seedBill(f, '2026-09');
  const mine = await seedBatch(f, own);
  const foreignOwnMonth = await seedBill(other, '2026-09');
  const foreignDraft = await seedBatch(other, foreignOwnMonth);
  const foreignScheduled = await seedBatch(other, foreignOwnMonth, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
  });
  const foreignPartial = await seedBatch(other, foreignOwnMonth, { status: 'PARTIAL' });
  await seedBill(other, '2026-08');
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const foreignBefore = await everything(other);
    const replies: unknown[] = [];
    const remember = async (sent: AdminSent) => {
      const body = await refused(sent, ['batch_id']);
      replies.push({ code: body.code, msg: body.msg, data: body.data });
    };
    const reject = (id: string) => h.reject(id, { expected_row_version: 0, reason: '驳回' });
    await remember(await h.cancelSchedule(foreignScheduled.batch_id, versionOf(foreignScheduled)));
    await remember(await h.cancelSchedule(randomUUID(), versionOf(foreignScheduled)));
    await remember(await h.cancelSchedule('not-a-uuid', versionOf(foreignScheduled)));
    await remember(await reject(foreignDraft.batch_id));
    await remember(await reject(randomUUID()));
    await remember(await reject('not-a-uuid'));
    await remember(await h.resume(foreignPartial.batch_id, versionOf(foreignPartial)));
    await remember(await h.resume(randomUUID(), versionOf(foreignPartial)));
    await remember(await h.resume('not-a-uuid', versionOf(foreignPartial)));
    expect(new Set(replies.map((reply) => JSON.stringify(reply))).size).toBe(1);

    await refused(await h.confirm('2026-08', { expected_batches: [] }), ['bill_id']);
    await refused(await h.supplement('2026-08', { platform: 'taobao' }), ['bill_id']);
    await conflict(
      await h.confirm(own.bill_id, { expected_batches: expected([mine, foreignDraft]) }),
    );
    expect(await everything(f)).toEqual(before);
    expect(await everything(other)).toEqual(foreignBefore);

    await answer(await h.confirm(own.bill_id, { expected_batches: expected([mine]) }), 0);
    expect(await everything(other)).toEqual(foreignBefore);
  });
  expect(await audits(other)).toEqual([]);
});
