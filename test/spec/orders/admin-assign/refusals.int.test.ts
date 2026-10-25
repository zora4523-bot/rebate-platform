// BR-ATTR-31（复查、权限中的目标用户、细则「改归属的目标用户」含 D10-152 的注销中 / 已注销）与契约
// adminReassignOrder 的 20001 / 20902。只测应用服务，路由不挂载（J-1）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assigned,
  fixture,
  open,
  untouched,
  type DeletionStage,
  type Fixture,
  type Harness,
} from './db-kit.ts';
import { AUDIT_ACTION, CONFLICT, fieldsError, targetRefused, type TargetRefusal } from './kit.ts';

let database: TestDatabase | undefined;
let h: Harness;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    await database?.drop();
  }
}, 30_000);

function nothingAssigned(f: Fixture) {
  expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
  expect(f.snapshots.create).not.toHaveBeenCalled();
  expect(f.events.publish).not.toHaveBeenCalled();
}

type Attributed = Partial<Insertable<DB['orders']>>;
const ATTRIBUTED: readonly (readonly [string, (f: Fixture, other: string) => Attributed])[] = [
  [
    '已按参数归属他人（ESTIMATED，未锁定）',
    (_f, other) => ({ user_id: other, user_basis: 'param', rebate_status: 'ESTIMATED' }),
  ],
  [
    '已由找回归属他人并锁定（CREDITED）',
    (_f, other) => ({
      user_id: other,
      user_basis: 'claim',
      locked: true,
      rebate_status: 'CREDITED',
    }),
  ],
  [
    '已归属他人且已作废（VOID）',
    (_f, other) => ({ user_id: other, user_basis: 'param', rebate_status: 'VOID' }),
  ],
  [
    '已归属给本次目标用户本人',
    (f) => ({ user_id: f.subject.user_id, user_basis: 'param', rebate_status: 'ESTIMATED' }),
  ],
];

it.each(ATTRIBUTED)(
  '[AC-B1-10f#6] 重读到 user_id 非空（%s）→ 20902 order_attribution，不调端口、不写任何东西',
  async (_label, patch) => {
    const f = await fixture(h);
    const o = await f.order(patch(f, await f.user()));
    const before = await f.state();
    expect(await f.assign(o, { expected_locked: o.locked })).toEqual(CONFLICT);
    nothingAssigned(f);
    const after = await f.state();
    untouched(after, before);
    expect(after.audits).toEqual(before.audits);
  },
);

it('[AC-B1-10f#7] 重读的 locked 与 expected_locked 不符 → 20902 order_attribution，不做任何修改', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const before = await f.state();
  expect(await f.assign(o, { expected_locked: true })).toEqual(CONFLICT);
  nothingAssigned(f);
  const after = await f.state();
  untouched(after, before);
  expect(after.audits).toEqual(before.audits);
});

type Refusal = readonly [string, (f: Fixture, userId: string) => Promise<void>, TargetRefusal];
const deleting =
  (stage: DeletionStage) =>
  (f: Fixture, userId: string): Promise<void> =>
    f.deletion(userId, stage);
const REFUSALS: readonly Refusal[] = [
  ['封禁（banned）', (f, userId) => f.risk(userId, 'banned'), 'target_banned'],
  ['注销冷静期（cooling）', deleting('cooling'), 'target_deleting'],
  ['注销处理中（processing）', deleting('processing'), 'target_deleting'],
  ['已注销（done）', deleting('done'), 'target_deleted'],
];
const KINDS = ['UNATTRIBUTED', 'VOID'] as const;

it.each(
  REFUSALS.flatMap(([label, setup, reason]) =>
    KINDS.map((kind) => [label, kind, setup, reason] as const),
  ),
)(
  '[AC-B1-10f#8] 目标用户%s、订单 %s → 20001 fields=[user_id] reason 对应，不写订单与快照、他人找回子项不动，写审计',
  async (_label, kind, setup, reason) => {
    const f = await fixture(h);
    const o = await f.order(
      kind === 'VOID' ? { rebate_status: 'VOID', platform_status: 'INVALID' } : {},
    );
    const c = await f.claim({ user_id: await f.user() });
    await f.item(c, o);
    const target = await f.user();
    await setup(f, target);
    const before = await f.state();
    expect(await f.assign(o, { user_id: target })).toEqual(targetRefused(reason));
    nothingAssigned(f);
    const after = await f.state();
    untouched(after, before);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    const audit = after.audits.at(-1);
    expect(audit).toMatchObject({
      app_id: f.appId,
      admin_id: f.adminId,
      action: AUDIT_ACTION,
      target: `orders:${o.order_id}`,
      at: f.clock.now(),
    });
    const written = JSON.stringify(audit?.after);
    expect(written).toContain(reason);
    expect(written).toContain(target);
  },
);

it('[AC-B1-10f#9] 风控状态行为 normal、没有注销记录的目标用户照常指派', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const target = await f.user();
  await f.risk(target, 'normal');
  const d = assigned(await f.assign(o, { user_id: target }));
  expect(d).toMatchObject({ user: { user_id: target } });
  expect((await f.state()).assignments.map((a) => a.to_user_id)).toEqual([target]);
});

it.each(['unknown', 'malformed', 'foreign'] as const)(
  '[AC-B1-10f#10] order_id %s（不存在 / 非 UUID / 他 App 的订单）→ 20001 fields=[order_id]，不调端口',
  async (kind) => {
    const f = await fixture(h);
    const o = await f.order();
    const orderId =
      kind === 'unknown'
        ? randomUUID()
        : kind === 'malformed'
          ? 'not-a-uuid'
          : (await f.foreign()).orderId;
    const before = await f.state();
    expect(await f.assign(o, { orderId })).toEqual(fieldsError('order_id'));
    nothingAssigned(f);
    untouched(await f.state(), before);
  },
);

it.each(['unknown', 'malformed', 'foreign'] as const)(
  '[AC-B1-10f#11] user_id %s（不存在 / 非 UUID / 他 App 的用户）→ 20001 fields=[user_id]（不带 reason），不做任何修改',
  async (kind) => {
    const f = await fixture(h);
    const o = await f.order();
    const userId =
      kind === 'unknown'
        ? randomUUID()
        : kind === 'malformed'
          ? 'nobody'
          : (await f.foreign()).userId;
    const before = await f.state();
    expect(await f.assign(o, { user_id: userId })).toEqual(fieldsError('user_id'));
    nothingAssigned(f);
    untouched(await f.state(), before);
  },
);

const REFUSED_REASONS: readonly (readonly [string, string])[] = [
  ['空串', ''],
  ['4 字', '核实指派'],
  ['201 字', '核'.repeat(201)],
];
const ACCEPTED_REASONS: readonly (readonly [string, string])[] = [
  ['5 字（下限）', '核实后指派'],
  ['200 字（上限）', '核'.repeat(200)],
];

it.each(REFUSED_REASONS)(
  '[AC-B1-10f#12] 原因 %s（不在 5～200 字）→ 20001 fields=[reason]，不调端口、不写任何东西',
  async (_label, reason) => {
    const f = await fixture(h);
    const o = await f.order();
    const before = await f.state();
    expect(await f.assign(o, { reason })).toEqual(fieldsError('reason'));
    nothingAssigned(f);
    const after = await f.state();
    untouched(after, before);
    expect(after.audits).toEqual(before.audits);
  },
);

it.each(ACCEPTED_REASONS)(
  '[AC-B1-10f#13] 原因 %s 受理，原样写进审计与 order_assignments',
  async (_label, reason) => {
    const f = await fixture(h);
    const o = await f.order();
    assigned(await f.assign(o, { reason }));
    const s = await f.state();
    expect(s.assignments.map((a) => a.reason)).toEqual([reason]);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]?.after).toMatchObject({ reason });
  },
);
