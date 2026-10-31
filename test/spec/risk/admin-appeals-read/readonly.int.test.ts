// B1-03zd: the three reads write nothing — app.appeals, user_risk_state, risk_hits, risk_rules,
// orders and audit_logs are as before, refused reads included. The only write the contract allows
// is the phone lookup's audit record (blocked-requests.int.test.ts); everything else stays.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  HOUR,
  accountAppeal,
  at,
  blocked,
  blockedAppeal,
  detail,
  found,
  member,
  order,
  orderAppeal,
  page,
  rejected,
  setup,
  snapshot,
} from './kit.ts';

const h = useHarness();

async function seed(s: Awaited<ReturnType<typeof setup>>) {
  const u = await member(s, { state: 'appealing' });
  const account = await accountAppeal(s, u, 'banned', { deadline_at: at(-HOUR) });
  const o = await order(s, u);
  const orderRow = await orderAppeal(s, u, o, { status: 'upheld', created_at: at(-2 * DAY) });
  const b = await blocked(s, { request_type: 'register', blocked_at: at(-3 * DAY) });
  const blockedRow = await blockedAppeal(s, b, { created_at: at(-2 * DAY) });
  return { u, rows: [account, orderRow, blockedRow], b };
}

it('[AC-B1-03zd#50] 列表、详情、按 UID / 编号查找重复读取前后，申诉、风控状态、命中、规则、订单与审计都不变', async () => {
  const s = await setup(h);
  const { u, rows, b } = await seed(s);
  const before = await snapshot(s);
  for (let n = 0; n < 2; n += 1) {
    expect((await page(await s.list())).total).toBe(3);
    expect((await page(await s.list({ overdue: 'true', q: u.id }))).total).toBe(1);
    for (const row of rows) expect((await detail(await s.detail(row.id))).appeal_id).toBe(row.id);
    expect((await found(await s.lookup({ user_id: u.id }))).total).toBe(0);
    expect((await found(await s.lookup({ blocked_request_id: b.id }))).total).toBe(1);
  }
  expect(await snapshot(s)).toEqual(before);
});

it('[AC-B1-03zd#51] 按手机号查找除一条审计外不改任何数据；被拒绝的读取什么都不写', async () => {
  const s = await setup(h);
  const { b } = await seed(s);
  const before = await snapshot(s);
  await rejected(await s.list({ status: 'pending' }), 20001, { fields: ['status'] });
  await rejected(await s.detail('not-an-appeal-id'), 20001, { fields: ['appeal_id'] });
  await rejected(await s.lookup({ phone: '12345678901' }), 20001, {
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  expect(await snapshot(s)).toEqual(before);
  expect((await found(await s.lookup({ phone: b.phone! }))).total).toBe(1);
  const after = await snapshot(s);
  expect({ ...after, audits: [] }).toEqual({ ...before, audits: [] });
  expect(after.audits).toHaveLength(before.audits.length + 1);
});
