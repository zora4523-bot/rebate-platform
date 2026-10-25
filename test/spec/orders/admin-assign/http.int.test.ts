// 契约 adminReassignOrder 的权限与动态码口径：权限点 order.assign（缺则 10403）、动态码档 step-up（无有效
// X-Step-Up-Token 则 10003 tier=totp），由操作守卫在用例之前判定；拒绝在守卫回调里抛出（不消耗令牌）。
// 不挂载（J-1）：直接调 orders 的 AdminOrderAssignHttp，守卫是假的，按 specs/permissions.yaml 的档位放行或拒绝。
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AdminOrderAssignHttp,
  type AdminAssignBody,
  type AdminAssignRequest,
} from '../../../../apps/api/src/modules/orders/http/admin/order-assign.http.ts';
import type { AdminActor } from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import {
  capture,
  fixture,
  open,
  untouched,
  type Fixture,
  type Harness,
  type Order,
} from './db-kit.ts';
import { GuardRefusal, IP, REASON, STEP_UP, conforms, envelopeOf, fakeGuard } from './kit.ts';

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

function request(headers: Record<string, string> = { 'x-step-up-token': STEP_UP }) {
  const value: AdminAssignRequest = { id: randomUUID(), ip: IP, headers };
  return value;
}

function body(f: Fixture, o: Order, patch: Partial<AdminAssignBody> = {}): AdminAssignBody {
  return {
    user_id: f.subject.user_id,
    expected_user_id: null,
    expected_locked: o.locked,
    reason: REASON,
    ...patch,
  };
}

/** The handler over the fixture's use case deps, behind a fake guard acting as a second admin. */
async function probe(f: Fixture) {
  const actor: AdminActor = {
    adminId: await f.admin(),
    appId: f.appId,
    isSuper: false,
    loginName: 'assign_probe',
  };
  const guard = fakeGuard(actor);
  const built = await capture(
    () => new AdminOrderAssignHttp({ guard: guard.guard, assign: f.deps }),
  );
  expect(built.ok, 'AdminOrderAssignHttp is constructed from { guard, assign }').toBe(true);
  if (!built.ok) throw built.error;
  return { actor, guard, http: built.value };
}

it('[AC-B1-10f#25] 守卫以 order.assign、写操作（不 readOnly、不改 operation）放行后才指派；操作者取守卫的 actor，审计 ip 取请求；响应为 AdminOrderDetailResponse', async () => {
  const f = await fixture(h);
  const o = await f.order();
  const p = await probe(f);
  const req = request();
  const response = await p.http.reassign(req, o.order_id, body(f, o));
  expect(p.guard.calls).toHaveLength(1);
  const input = p.guard.calls[0]!;
  expect(input.request).toBe(req);
  expect([input.permission].flat()).toEqual(['order.assign']);
  expect(input.readOnly).not.toBe(true);
  expect(input.operation).toBeUndefined();
  expect(p.guard.outcomes).toEqual([{ ok: true, code: 0 }]);
  expect(response).toMatchObject({
    code: 0,
    trace_id: req.id,
    data: {
      order_id: o.order_id,
      user: { user_id: f.subject.user_id },
      user_basis: 'admin',
      flags: { locked: true },
    },
  });
  await conforms(response, 'AdminOrderDetailResponse');
  const s = await f.state();
  expect(s.assignments).toHaveLength(1);
  expect(s.assignments[0]).toMatchObject({
    admin_id: p.actor.adminId,
    to_user_id: f.subject.user_id,
  });
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]).toMatchObject({ admin_id: p.actor.adminId, ip: IP });
});

type GuardCase = readonly [string, number, readonly string[], Record<string, string>];
const GUARD_CASES: readonly GuardCase[] = [
  [
    '没有 order.assign 权限点',
    10403,
    ['order.view', 'order.claim'],
    { 'x-step-up-token': STEP_UP },
  ],
  ['未带 X-Step-Up-Token', 10003, ['order.view', 'order.assign'], {}],
  [
    'X-Step-Up-Token 无效',
    10003,
    ['order.view', 'order.assign'],
    { 'x-step-up-token': 'plain-plain-plain-plain' },
  ],
];

it.each(GUARD_CASES)(
  '[AC-B1-10f#26] %s → 守卫拒绝 %s，用例不运行：不调端口、不读目标、什么都不写',
  async (_label, code, keys, headers) => {
    const f = await fixture(h);
    const o = await f.order();
    const p = await probe(f);
    p.guard.held.keys = keys;
    const before = await f.state();
    const req = request({ ...headers });
    const refused = await capture(() => p.http.reassign(req, o.order_id, body(f, o)));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a guard refusal');
    expect(refused.error).toBeInstanceOf(GuardRefusal);
    expect(envelopeOf(refused.error).body).toMatchObject({ code, trace_id: req.id });
    expect(p.guard.outcomes).toEqual([]);
    expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
    expect(f.targets.risk.read).not.toHaveBeenCalled();
    expect(f.targets.deletion.read).not.toHaveBeenCalled();
    const after = await f.state();
    untouched(after, before);
    expect(after.audits).toEqual(before.audits);
  },
);

type Refusal = readonly [
  string,
  number,
  (f: Fixture) => Promise<Partial<AdminAssignBody>>,
  Record<string, unknown>,
];
const REFUSALS: readonly Refusal[] = [
  [
    '期望不符',
    409,
    async () => ({ expected_locked: true }),
    { code: 20902, data: { resource: 'order_attribution' } },
  ],
  [
    '目标封禁',
    400,
    async (f) => {
      const target = await f.user();
      await f.risk(target, 'banned');
      return { user_id: target };
    },
    { code: 20001, data: { fields: ['user_id'], reason: 'target_banned' } },
  ],
  [
    '原因过短',
    400,
    async () => ({ reason: '核实指派' }),
    { code: 20001, data: { fields: ['reason'] } },
  ],
];

it.each(REFUSALS)(
  '[AC-B1-10f#27] %s → HTTP %s：在守卫回调里抛出错误信封，守卫不当作成功（不消耗令牌）',
  async (_label, status, patch, expected) => {
    const f = await fixture(h);
    const o = await f.order();
    const p = await probe(f);
    const req = request();
    const patched = body(f, o, await patch(f));
    const refused = await capture(() => p.http.reassign(req, o.order_id, patched));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    const envelope = envelopeOf(refused.error);
    expect(envelope.status).toBe(status);
    expect(envelope.body).toMatchObject({ ...expected, trace_id: req.id });
    expect(envelope.body['data']).toEqual(expected['data']);
    await conforms(envelope.body, 'ErrorEnvelope');
    expect(p.guard.outcomes).toHaveLength(1);
    expect(p.guard.outcomes[0]).toMatchObject({ ok: false, error: refused.error });
    expect(f.rebate.onAdminAssigned).not.toHaveBeenCalled();
  },
);
