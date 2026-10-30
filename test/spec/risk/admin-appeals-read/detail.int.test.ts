// B1-03zd: GET /admin/v1/appeals/{appeal_id} (adminGetAppeal; CT-24r) — the list row plus content,
// current risk_state, source, claim / close times, row_version, revoke_permission (编排裁定
// D10-154), the blocked request and the related risk_hits (newest first, at most 50; never the hit
// value, its HMAC or the rule's conditions; BR-ID-36, BR-ID-33). Unknown or foreign ids → 20001.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  HOUR,
  accountAppeal,
  admin,
  at,
  blocked,
  blockedAppeal,
  detail,
  hit,
  instants,
  iso,
  member,
  noSecrets,
  order,
  orderAppeal,
  phoneNumber,
  rejected,
  setup,
  type AppealRow,
  type Detail,
  type Scenario,
} from './kit.ts';

const h = useHarness();

/** The comparable part of the detail's hit rows (rule_name has no source of its own to compare). */
const hits = (d: Detail) =>
  d.risk_hits.map((r) => ({
    created_at: iso(r.created_at),
    rule_id: r.rule_id,
    risk_action: r.risk_action,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
  }));

it('[AC-B1-03zd#30] 账户申诉详情：列表字段加陈述、当前风控状态、来源、版本、revoke_permission=risk.ban 与该用户的命中记录', async () => {
  const s = await setup(h);
  const named = await admin(h, s.appId, { display_name: '客服小林' });
  const u = await member(s, { state: 'appealing' });
  const someone = await member(s);
  const orderHit = await hit(s, {
    user_id: u.id,
    rule_id: 'RIGHTS_ABUSE',
    ref_type: 'order',
    ref_id: randomUUID(),
    created_at: at(-3 * DAY),
  });
  const withdrawalHit = await hit(s, {
    user_id: u.id,
    rule_id: 'WITHDRAW_VELOCITY',
    ref_type: 'withdrawal',
    ref_id: randomUUID(),
    created_at: at(-2 * DAY),
    risk_action: 'block',
  });
  const b = await blocked(s, {
    request_type: 'payout_account',
    user: u,
    rules: [{ rule_id: 'BLACKLIST_ALIPAY', dimension: 'alipay' }],
    blocked_at: at(-HOUR),
  });
  await hit(s, {
    user_id: someone.id,
    rule_id: 'RIGHTS_ABUSE',
    ref_type: 'order',
    ref_id: randomUUID(),
    created_at: at(-HOUR),
  });
  const row = await accountAppeal(s, u, 'banned', {
    content: '我没有恶意维权，退款都是商家同意的，请核查。',
    created_at: at(-DAY),
    deadline_at: at(2 * DAY),
    handler_id: named.id,
    row_version: 1,
  });

  const d = await detail(await s.detail(row.id));
  expect(instants(d)).toEqual({
    appeal_id: row.id,
    user: { user_id: u.id, phone_masked: u.masked },
    target_type: 'account',
    target_id: u.id,
    target_no: u.id,
    request_type: null,
    prev_risk_state: 'banned',
    created_at: row.created_at.toISOString(),
    deadline_at: row.deadline_at.toISOString(),
    status: 'processing',
    handler_id: named.id,
    handler_name: '客服小林',
    content: '我没有恶意维权，退款都是商家同意的，请核查。',
    risk_state: 'appealing',
    source: 'app',
    registered_by: null,
    registered_by_name: null,
    // Claim time has no seeded source here; only its shape is checked by the contract.
    claimed_at: d.claimed_at === null ? null : iso(d.claimed_at),
    closed_at: null,
    row_version: 1,
    revoke_permission: 'risk.ban',
    blocked_request: null,
    risk_hits: expect.any(Array),
  });
  expect(hits(d)).toEqual([
    {
      created_at: at(-HOUR).toISOString(),
      rule_id: 'BLACKLIST_ALIPAY',
      risk_action: 'block',
      ref_type: 'blocked_request',
      ref_id: b.id,
    },
    {
      created_at: withdrawalHit.created_at.toISOString(),
      rule_id: 'WITHDRAW_VELOCITY',
      risk_action: 'block',
      ref_type: 'withdrawal',
      ref_id: withdrawalHit.ref_id,
    },
    {
      created_at: orderHit.created_at.toISOString(),
      rule_id: 'RIGHTS_ABUSE',
      risk_action: 'manual_review',
      ref_type: 'order',
      ref_id: orderHit.ref_id,
    },
  ]);
  noSecrets(
    [d, s.f.lines],
    [u.phone, u.hmac, orderHit.value_hmac, withdrawalHit.value_hmac, ...b.secrets],
  );
});

it('[AC-B1-03zd#31] 订单申诉详情：对象编号为子订单号，只列以该订单为对象的命中；结案后有 closed_at、claimed_at 清空、处理人为结案人', async () => {
  const s = await setup(h);
  const resolver = await admin(h, s.appId);
  const u = await member(s, { phone: null, state: 'normal' });
  const o = await order(s, u);
  const elsewhere = await order(s, u);
  const first = await hit(s, {
    user_id: u.id,
    rule_id: 'RIGHTS_ABUSE',
    ref_type: 'order',
    ref_id: o.order_id,
    created_at: at(-5 * DAY),
    risk_action: 'manual_review',
  });
  const second = await hit(s, {
    user_id: u.id,
    rule_id: 'ORDER_FRAUD',
    ref_type: 'order',
    ref_id: o.order_id,
    created_at: at(-4 * DAY),
    risk_action: 'void_commission',
  });
  await hit(s, {
    user_id: u.id,
    rule_id: 'RIGHTS_ABUSE',
    ref_type: 'order',
    ref_id: elsewhere.order_id,
    created_at: at(-3 * DAY),
  });
  await hit(s, {
    user_id: u.id,
    rule_id: 'WITHDRAW_VELOCITY',
    ref_type: 'withdrawal',
    ref_id: randomUUID(),
    created_at: at(-2 * DAY),
  });
  const row = await orderAppeal(s, u, o, {
    status: 'upheld',
    created_at: at(-3 * DAY),
    handler_id: resolver.id,
    closed_at: at(-2 * DAY),
    row_version: 2,
  });

  const d = await detail(await s.detail(row.id));
  expect(instants({ ...d, risk_hits: [] })).toEqual({
    appeal_id: row.id,
    user: { user_id: u.id, phone_masked: null },
    target_type: 'order',
    target_id: o.order_id,
    target_no: o.sub_order_id,
    request_type: null,
    prev_risk_state: null,
    created_at: row.created_at.toISOString(),
    deadline_at: row.deadline_at.toISOString(),
    status: 'upheld',
    handler_id: resolver.id,
    handler_name: resolver.username,
    content: row.content,
    risk_state: 'normal',
    source: 'app',
    registered_by: null,
    registered_by_name: null,
    claimed_at: null,
    closed_at: at(-2 * DAY).toISOString(),
    row_version: 2,
    revoke_permission: null,
    blocked_request: null,
    risk_hits: [],
  });
  expect(hits(d)).toEqual([
    {
      created_at: second.created_at.toISOString(),
      rule_id: 'ORDER_FRAUD',
      risk_action: 'void_commission',
      ref_type: 'order',
      ref_id: o.order_id,
    },
    {
      created_at: first.created_at.toISOString(),
      rule_id: 'RIGHTS_ABUSE',
      risk_action: 'manual_review',
      ref_type: 'order',
      ref_id: o.order_id,
    },
  ]);
});

it('[AC-B1-03zd#32] 注册类被拦请求申诉：无申诉人与风控状态，附被拦请求（脱敏手机号、名单原因）与其命中，revoke_permission=risk.blocklist', async () => {
  const s = await setup(h);
  const b = await blocked(s, {
    request_type: 'register',
    rules: [{ rule_id: 'BLACKLIST_PHONE', dimension: 'phone' }],
    blocked_at: at(-2 * HOUR),
  });
  // Another request of the same number: its hits are not this appeal's.
  const again = await blocked(s, {
    request_type: 'register',
    phone: b.phone,
    blocked_at: at(-HOUR),
  });
  const row = await blockedAppeal(s, b, { created_at: at(-90 * 60_000), deadline_at: at(3 * DAY) });

  const d = await detail(await s.detail(row.id));
  expect(d).toMatchObject({
    appeal_id: row.id,
    user: null,
    target_type: 'blocked_request',
    target_id: b.id,
    target_no: b.id,
    request_type: 'register',
    prev_risk_state: null,
    status: 'processing',
    handler_id: null,
    handler_name: null,
    content: row.content,
    risk_state: null,
    claimed_at: null,
    closed_at: null,
    row_version: 0,
    revoke_permission: 'risk.blocklist',
  });
  expect(instants(d.blocked_request!)).toEqual({
    blocked_request_id: b.id,
    request_type: 'register',
    phone_masked: b.masked,
    blocked_at: b.blocked_at.toISOString(),
    cause: 'blocklist',
    blocklist_dimension: 'phone',
    amount_fen: null,
    processing_appeal_id: row.id,
  });
  expect(hits(d)).toEqual([
    {
      created_at: b.blocked_at.toISOString(),
      rule_id: 'BLACKLIST_PHONE',
      risk_action: 'block',
      ref_type: 'blocked_request',
      ref_id: b.id,
    },
  ]);
  noSecrets([d, s.f.lines], [b.phone, ...b.secrets, ...again.secrets]);
});

it('[AC-B1-03zd#33] 提现类被拦请求申诉（非名单原因、已撤销）：附申请金额与申诉人，revoke_permission=null，processing_appeal_id 结案后为 null', async () => {
  const s = await setup(h);
  const u = await member(s, { state: 'normal' });
  const b = await blocked(s, {
    request_type: 'withdraw',
    user: u,
    rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
    amount_fen: 12345,
    blocked_at: at(-3 * DAY),
  });
  const row = await blockedAppeal(s, b, {
    status: 'revoked',
    created_at: at(-2 * DAY),
    closed_at: at(-DAY),
    row_version: 2,
  });
  const d = await detail(await s.detail(row.id));
  expect(d).toMatchObject({
    user: { user_id: u.id, phone_masked: u.masked },
    target_type: 'blocked_request',
    target_no: b.id,
    request_type: 'withdraw',
    status: 'revoked',
    risk_state: 'normal',
    claimed_at: null,
    row_version: 2,
    revoke_permission: null,
  });
  expect(iso(d.closed_at!)).toBe(at(-DAY).toISOString());
  expect(instants(d.blocked_request!)).toEqual({
    blocked_request_id: b.id,
    request_type: 'withdraw',
    phone_masked: u.masked,
    blocked_at: b.blocked_at.toISOString(),
    cause: 'rule',
    blocklist_dimension: null,
    amount_fen: 12345,
    processing_appeal_id: null,
  });
  noSecrets([d, s.f.lines], [u.phone, ...b.secrets]);
});

type Kind = 'banned' | 'frozen' | 'blocklist' | 'rule' | 'order';

async function seedKind(s: Scenario, kind: Kind, status: 'processing' | 'revoked') {
  const patch = { status, created_at: at(-DAY) };
  switch (kind) {
    case 'banned':
    case 'frozen':
      return accountAppeal(
        s,
        await member(s, { state: status === 'processing' ? 'appealing' : 'normal' }),
        kind,
        patch,
      );
    case 'blocklist':
      return blockedAppeal(
        s,
        await blocked(s, {
          request_type: 'phone_change',
          user: await member(s),
          phone: phoneNumber(),
          rules: [{ rule_id: 'BLACKLIST_PHONE', dimension: 'phone' }],
          blocked_at: at(-2 * DAY),
        }),
        patch,
      );
    case 'rule':
      // Same-device register limit: hit dimension device, but no blocklist entry caused it.
      return blockedAppeal(
        s,
        await blocked(s, {
          request_type: 'register',
          rules: [{ rule_id: 'DEVICE_REGISTER_LIMIT', dimension: 'device' }],
          blocked_at: at(-2 * DAY),
        }),
        patch,
      );
    case 'order': {
      const u = await member(s);
      return orderAppeal(s, u, await order(s, u), patch);
    }
  }
}

it.each([
  ['banned', 'risk.ban'],
  ['frozen', 'risk.freeze'],
  ['blocklist', 'risk.blocklist'],
  ['rule', null],
  ['order', null],
] as const)(
  '[AC-B1-03zd#34] revoke_permission：%s → %s，处理中与已结案一致',
  async (kind, expected) => {
    const s = await setup(h);
    for (const status of ['processing', 'revoked'] as const) {
      const row: AppealRow = await seedKind(s, kind, status);
      expect((await detail(await s.detail(row.id))).revoke_permission, status).toBe(expected);
    }
  },
);

it('[AC-B1-03zd#35] 命中记录最多 50 条，取最新的，按时间倒序', async () => {
  const s = await setup(h);
  const u = await member(s, { state: 'appealing' });
  const refs: string[] = [];
  for (let n = 0; n < 52; n += 1) {
    const ref = randomUUID();
    refs.push(ref);
    await hit(s, {
      user_id: u.id,
      rule_id: 'RIGHTS_ABUSE',
      ref_type: 'order',
      ref_id: ref,
      created_at: at(-(n + 1) * 60_000),
    });
  }
  const row = await accountAppeal(s, u, 'frozen');
  const d = await detail(await s.detail(row.id));
  expect(d.risk_hits).toHaveLength(50);
  expect(d.risk_hits.map((r) => r.ref_id)).toEqual(refs.slice(0, 50));
});

it('[AC-B1-03zd#36] 未知、非 UUID 与别的应用的 appeal_id → 20001 [appeal_id]，身份头不能换应用', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const foreign = await accountAppeal(other, await member(other, { state: 'appealing' }), 'banned');
  for (const id of [randomUUID(), 'not-an-appeal-id', foreign.id]) {
    await rejected(await s.detail(id, { 'x-app-id': other.appId }), 20001, {
      fields: ['appeal_id'],
    });
  }
});
