// B1-03ze: POST /admin/v1/appeals/{appeal_id}/resolve (adminResolveAppeal; CT-24r; BR-ID-36,
// BR-ID-31). In one transaction: status = decision, closed_at = now, handler_id = the resolver,
// claimed_at null, row_version + 1; account upheld → risk_state back to prev_risk_state, revoked →
// normal (a ban revoked unbans as BR-ID-31: ban-blocked taobao bindings invalid, others active);
// order and blocked_request appeals change no risk_state; blocked_request revoked with cause
// blocklist → the blocklist entries that caused it stop being active (the removal audited);
// appeal.resolved {app_id, appeal_id, user_id, target_type, target_id, status} queued on the same
// transaction; audit appeal_resolve (decision, note, state before and after). The note is
// audit-only. CAS: stale version, a closed appeal or the loser of two concurrent resolutions →
// 20902 resource=appeal, nothing changed.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { EVENT_BUS, type EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CONFLICT,
  EXTRA,
  NOTE,
  UNKNOWN,
  appAudits,
  appealOf,
  appealRow,
  auditsOf,
  binding,
  blockedAppeal,
  blocklisted,
  colleague,
  instants,
  iso,
  member,
  noPersonalData,
  phoneEntry,
  phoneNumber,
  refused,
  resolution,
  resolvedEvents,
  riskRow,
  seed,
  setup,
  snapshot,
  text,
  type Decision,
  type Kind,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const ALL = ['risk.appeal', ...EXTRA];
const KINDS = ['banned', 'frozen', 'blocklist', 'rule', 'order', 'register'] as const;

const bindingRow = (s: Scenario, id: string) =>
  s.h.db.selectFrom('union_bindings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** Resolves with every point and, for a revocation, a fresh step-up token. */
async function close(s: Scenario, id: string, decision: Decision, version: number) {
  const token = decision === 'revoked' ? await s.issue() : null;
  return s.resolve(id, resolution(decision, version), token);
}

it.each(['banned', 'frozen'] as const)(
  '[AC-B1-03ze#40] 维持 %s 账户申诉：risk_state 恢复申诉前状态；处理人为结案人、claimed_at 清空、版本 +1',
  async (prev) => {
    const s = await setup(h, { displayName: '风控小王' });
    const claimer = await colleague(s);
    const { row, user } = await seed(s, prev);
    await appealOf(await claimer.claim(row.id, { expected_row_version: 0 }));
    s.f.clock.advanceMs(60_000);
    const now = s.f.clock.now();
    const d = await appealOf(await s.resolve(row.id, resolution('upheld', 1)));
    expect(d).toMatchObject({
      appeal_id: row.id,
      status: 'upheld',
      prev_risk_state: prev,
      risk_state: prev,
      handler_id: s.a.id,
      handler_name: '风控小王',
      claimed_at: null,
      row_version: 2,
    });
    expect(iso(d.closed_at!)).toBe(now.toISOString());
    expect(await appealRow(s, row.id)).toMatchObject({
      status: 'upheld',
      prev_risk_state: prev,
      handler_id: s.a.id,
      closed_at: now,
      row_version: 2,
    });
    // The freeze comes back with its term from before the appeal (the seed's 2090-01-01), not a
    // new one and not none; a ban has no term.
    expect(await riskRow(s, user!.id)).toMatchObject({
      state: prev,
      frozen_until: prev === 'frozen' ? new Date('2090-01-01T00:00:00Z') : null,
    });
    expect(instants(await appealOf(await s.detail(row.id)))).toEqual(instants(d));
  },
);

it.each([
  ['taobao', 'invalid'],
  ['pdd', 'active'],
] as const)(
  '[AC-B1-03ze#41] 撤销封禁申诉：risk_state=normal，按 BR-ID-31 解封（ban 冻结的 %s 绑定 → %s），其他原因的绑定不动',
  async (platform, restored) => {
    const s = await setup(h, { grants: ['risk.appeal', 'risk.ban'] });
    const { row, user } = await seed(s, 'banned');
    const banned = await binding(s, user!.id, {
      platform,
      status: 'blocked',
      blocked_reason: 'ban',
    });
    const disabled = await binding(s, user!.id, {
      platform: platform === 'taobao' ? 'pdd' : 'taobao',
      status: 'blocked',
      blocked_reason: 'admin_disable',
    });
    const d = await appealOf(await close(s, row.id, 'revoked', 0));
    expect(d).toMatchObject({
      status: 'revoked',
      risk_state: 'normal',
      handler_id: s.a.id,
      claimed_at: null,
      row_version: 1,
    });
    expect(await appealRow(s, row.id)).toMatchObject({ status: 'revoked', row_version: 1 });
    expect(await riskRow(s, user!.id)).toMatchObject({ state: 'normal', frozen_until: null });
    expect(await bindingRow(s, banned.id)).toMatchObject({
      status: restored,
      blocked_reason: null,
    });
    expect(await bindingRow(s, disabled.id)).toEqual(disabled);
  },
);

it('[AC-B1-03ze#42] 撤销冻结申诉：risk_state=normal、无冻结期限，绑定不动', async () => {
  const s = await setup(h, { grants: ['risk.appeal', 'risk.freeze'] });
  const { row, user } = await seed(s, 'frozen');
  const active = await binding(s, user!.id);
  const disabled = await binding(s, user!.id, {
    platform: 'pdd',
    status: 'blocked',
    blocked_reason: 'admin_disable',
  });
  const d = await appealOf(await close(s, row.id, 'revoked', 0));
  expect(d).toMatchObject({ status: 'revoked', risk_state: 'normal', prev_risk_state: 'frozen' });
  expect(await riskRow(s, user!.id)).toMatchObject({ state: 'normal', frozen_until: null });
  expect(await bindingRow(s, active.id)).toEqual(active);
  expect(await bindingRow(s, disabled.id)).toEqual(disabled);
});

for (const kind of ['order', 'rule', 'register'] as const) {
  it.each(['upheld', 'revoked'] as const)(
    `[AC-B1-03ze#43] ${kind} 申诉结案（%s）不改任何 risk_state，订单仍为作废`,
    async (decision) => {
      const s = await setup(h, { grants: ALL });
      const { row, user, order } = await seed(s, kind);
      const before = await snapshot(s);
      const d = await appealOf(await close(s, row.id, decision, 0));
      expect(d).toMatchObject({ status: decision, handler_id: s.a.id, row_version: 1 });
      expect(d.risk_state).toBe(user === null ? null : 'normal');
      expect(await appealRow(s, row.id)).toMatchObject({ status: decision, handler_id: s.a.id });
      const after = await snapshot(s);
      expect(after.risk).toEqual(before.risk);
      expect(after.bindings).toEqual(before.bindings);
      if (order !== null) {
        expect(after.orders.find((o) => o.order_id === order.order_id)).toMatchObject({
          rebate_status: 'VOID',
        });
      }
    },
  );
}

it.each(['register', 'phone_change'] as const)(
  '[AC-B1-03ze#44] 撤销名单拦截的 %s 被拦请求申诉：致拦的名单条目不再生效，别的条目不动，不改 risk_state',
  async (requestType) => {
    const s = await setup(h, { grants: ['risk.appeal', 'risk.blocklist'] });
    const user = requestType === 'register' ? null : await member(s);
    const { b, entry } = await blocklisted(s, { request_type: requestType, user });
    const unrelated = await phoneEntry(s, phoneNumber());
    const row = await blockedAppeal(s, b);
    const before = await snapshot(s);
    const earlier = new Set((await appAudits(s)).map((a) => a.id));
    const d = await appealOf(await close(s, row.id, 'revoked', 0));
    expect(d).toMatchObject({ status: 'revoked', revoke_permission: 'risk.blocklist' });
    const after = await snapshot(s);
    expect(after.blocklist.filter((r) => r.id === entry && r.status === 'active')).toEqual([]);
    expect(after.blocklist.find((r) => r.id === unrelated)).toEqual(
      before.blocklist.find((r) => r.id === unrelated),
    );
    expect(after.risk).toEqual(before.risk);
    // The removal is audited (CT-24r; BR-ID-36 细则「被拦截请求申诉」撤销「BR-ID-31，写审计」):
    // the records written by this resolution name the removed entry, not the untouched one, and
    // carry neither the phone number nor its HMAC.
    const written = (await appAudits(s)).filter((a) => !earlier.has(a.id));
    expect(text(written)).toContain(entry);
    expect(text(written)).not.toContain(unrelated);
    noPersonalData(written, b.secrets);
  },
);

it('[AC-B1-03ze#45] 维持名单拦截的被拦请求申诉：名单条目原样生效', async () => {
  const s = await setup(h);
  const { b } = await blocklisted(s, { request_type: 'register' });
  const row = await blockedAppeal(s, b);
  const before = await snapshot(s);
  await appealOf(await s.resolve(row.id, resolution('upheld', 0)));
  const after = await snapshot(s);
  expect(after.blocklist).toEqual(before.blocklist);
  expect(after.risk).toEqual(before.risk);
});

it('[AC-B1-03ze#46] 版本不符 → 20902 resource=appeal，什么都不改', async () => {
  const s = await setup(h, { grants: ALL });
  const { row } = await seed(s, 'banned', { row_version: 3 });
  const before = await snapshot(s);
  for (const version of [0, 2, 4]) {
    for (const decision of ['upheld', 'revoked'] as const) {
      await refused(await close(s, row.id, decision, version), 20902, CONFLICT);
    }
  }
  expect(await snapshot(s)).toEqual(before);
});

it.each(KINDS)('[AC-B1-03ze#47] 已结案的 %s 申诉再结案 → 20902，什么都不改', async (kind) => {
  const s = await setup(h, { grants: ALL });
  const { row } = await seed(s, kind);
  await appealOf(await s.resolve(row.id, resolution('upheld', 0)));
  const after = await snapshot(s);
  for (const decision of ['upheld', 'revoked'] as const) {
    for (const version of [0, 1]) {
      await refused(await close(s, row.id, decision, version), 20902, CONFLICT);
    }
  }
  expect(await snapshot(s)).toEqual(after);
  expect(await resolvedEvents(s)).toHaveLength(1);
  expect(await auditsOf(s, 'appeal_resolve')).toHaveLength(1);
});

it('[AC-B1-03ze#48] 未知、非 UUID 与别的应用的 appeal_id → 20001 [appeal_id]，身份头不能换应用', async () => {
  const s = await setup(h, { grants: ALL });
  const other = await setup(h);
  const { row: foreign } = await seed(other, 'banned');
  const before = await snapshot(other);
  for (const id of [randomUUID(), 'not-an-appeal-id', foreign.id]) {
    await refused(
      await s.resolve(id, resolution('upheld', 0), null, { 'x-app-id': other.appId }),
      20001,
      UNKNOWN,
    );
  }
  expect(await snapshot(other)).toEqual(before);
});

it.each<[string, Record<string, unknown>, string]>([
  ['decision 缺失', { note: NOTE, expected_row_version: 0 }, 'decision'],
  ['decision 非枚举', { decision: 'approved', note: NOTE, expected_row_version: 0 }, 'decision'],
  ['note 缺失', { decision: 'upheld', expected_row_version: 0 }, 'note'],
  ['note 为空', { decision: 'upheld', note: '', expected_row_version: 0 }, 'note'],
  ['note 只有空白', { decision: 'upheld', note: ' \t ', expected_row_version: 0 }, 'note'],
  ['note 201 字', { decision: 'upheld', note: '因'.repeat(201), expected_row_version: 0 }, 'note'],
  ['note 非字符串', { decision: 'upheld', note: 1, expected_row_version: 0 }, 'note'],
  ['版本缺失', { decision: 'upheld', note: NOTE }, 'expected_row_version'],
  [
    '版本为负',
    { decision: 'upheld', note: NOTE, expected_row_version: -1 },
    'expected_row_version',
  ],
  [
    '版本为字符串',
    { decision: 'upheld', note: NOTE, expected_row_version: '0' },
    'expected_row_version',
  ],
])('[AC-B1-03ze#49] 请求体 %s → 20001 [%s]，什么都不改', async (_label, body, field) => {
  const s = await setup(h);
  const { row } = await seed(s, 'banned');
  const before = await snapshot(s);
  await refused(await s.resolve(row.id, body), 20001, { fields: [field] });
  expect(await snapshot(s)).toEqual(before);
});

// The request schema's maxLength 200 is checked on the raw body (platform validation does not
// trim), so the trimming boundary is shown with raw values of at most 200 characters.
it.each([
  ['因', '因'],
  ['因'.repeat(200), '因'.repeat(200)],
  [`  ${'因'.repeat(196)}  `, '因'.repeat(196)],
  [`\t${'因'.repeat(198)}\n`, '因'.repeat(198)],
])('[AC-B1-03ze#50] 说明边界 %j 可结案，审计记去空白后的说明', async (note, trimmed) => {
  const s = await setup(h);
  const { row } = await seed(s, 'order');
  await appealOf(await s.resolve(row.id, resolution('upheld', 0, note)));
  const audits = await auditsOf(s, 'appeal_resolve');
  expect(audits).toHaveLength(1);
  // The note is one JSON string value, exactly the trimmed text.
  expect(text(audits[0])).toContain(JSON.stringify(trimmed));
});

it.each([` ${'因'.repeat(200)}`, `${'因'.repeat(200)}\n`, `  ${'因'.repeat(199)}  `])(
  '[AC-B1-03ze#72] 说明原始长度超过 200（去空白后不超）%j → 20001 [note]，什么都不改',
  async (note) => {
    const s = await setup(h);
    const { row } = await seed(s, 'order');
    const before = await snapshot(s);
    await refused(await s.resolve(row.id, resolution('upheld', 0, note)), 20001, {
      fields: ['note'],
    });
    expect(await snapshot(s)).toEqual(before);
  },
);

for (const kind of KINDS) {
  it.each(['upheld', 'revoked'] as const)(
    `[AC-B1-03ze#51] ${kind} 结案（%s）恰好排一条 appeal.resolved，载荷含六字段`,
    async (decision) => {
      const s = await setup(h, { grants: ALL });
      const { row } = await seed(s, kind);
      expect(await resolvedEvents(s)).toEqual([]);
      await appealOf(await close(s, row.id, decision, 0));
      const events = await resolvedEvents(s);
      expect(events).toHaveLength(1);
      expect(events[0]!.app_id).toBe(s.appId);
      expect(events[0]!.data).toMatchObject({
        app_id: s.appId,
        appeal_id: row.id,
        user_id: row.user_id,
        target_type: row.target_type,
        target_id: row.target_id,
        status: decision,
      });
      // Ids only: never the statement, the note or a phone number.
      const text = JSON.stringify(events[0]!.data);
      expect(text).not.toContain(row.content);
      expect(text).not.toContain(NOTE);
    },
  );
}

it('[AC-B1-03ze#52] appeal.resolved 与结案同一事务：发布时事务内已结案、风控已恢复，事务外仍是处理中', async () => {
  const s = await setup(h, { grants: ['risk.appeal', 'risk.ban'] });
  const { row, user } = await seed(s, 'banned');
  const token = await s.issue();
  const bus = s.f.app.get<EventBus>(EVENT_BUS);
  const original = bus.publish.bind(bus);
  const seen: unknown[] = [];
  const publish = vi.spyOn(bus, 'publish').mockImplementation(async (trx, event) => {
    if (event.name === 'appeal.resolved') {
      const app = trx.withSchema('app');
      const outside = await appealRow(s, row.id);
      seen.push({
        transaction: trx.isTransaction,
        inside: await app
          .selectFrom('appeals')
          .select(['status', 'row_version'])
          .where('id', '=', row.id)
          .executeTakeFirst(),
        risk: await app
          .selectFrom('user_risk_state')
          .select('state')
          .where('app_id', '=', s.appId)
          .where('user_id', '=', user!.id)
          .executeTakeFirst(),
        outside: { status: outside.status, row_version: outside.row_version },
      });
    }
    return original(trx, event);
  });
  try {
    await appealOf(await s.resolve(row.id, resolution('revoked', 0), token));
  } finally {
    publish.mockRestore();
  }
  expect(seen).toEqual([
    {
      transaction: true,
      inside: { status: 'revoked', row_version: 1 },
      risk: { state: 'normal' },
      outside: { status: 'processing', row_version: 0 },
    },
  ]);
  expect(await resolvedEvents(s)).toHaveLength(1);
});

it.each(['banned', 'order'] as const)(
  '[AC-B1-03ze#53] %s：排 appeal.resolved 失败则整体回滚（申诉、风控、绑定、审计、事件都不留），之后可正常结案',
  async (kind) => {
    const s = await setup(h, { grants: ALL });
    const { row, user } = await seed(s, kind);
    const banned = await binding(s, user!.id, { status: 'blocked', blocked_reason: 'ban' });
    const before = await snapshot(s);
    const token = await s.issue();
    const bus = s.f.app.get<EventBus>(EVENT_BUS);
    const original = bus.publish.bind(bus);
    const publish = vi.spyOn(bus, 'publish').mockImplementation(async (trx, event) => {
      if (event.name === 'appeal.resolved') throw new Error('synthetic-publish-failure');
      return original(trx, event);
    });
    try {
      await refused(await s.resolve(row.id, resolution('revoked', 0), token), 50001);
    } finally {
      publish.mockRestore();
    }
    expect(await snapshot(s)).toEqual(before);
    await appealOf(await close(s, row.id, 'revoked', 0));
    expect(await resolvedEvents(s)).toHaveLength(1);
    expect(await auditsOf(s, 'appeal_resolve')).toHaveLength(1);
    if (kind === 'banned') {
      expect(await bindingRow(s, banned.id)).toMatchObject({ status: 'invalid' });
    }
  },
);

it('[AC-B1-03ze#54] 审计 appeal_resolve：结案人、决定、说明、前后状态；说明不进申诉行、应答与事件，审计不含手机号明文与 HMAC', async () => {
  const s = await setup(h, { grants: ['risk.appeal', 'risk.blocklist'] });
  const { b } = await blocklisted(s, { request_type: 'register' });
  const row = await blockedAppeal(s, b);
  const response = await close(s, row.id, 'revoked', 0);
  const d = await appealOf(response);
  const audits = await auditsOf(s, 'appeal_resolve');
  expect(audits).toHaveLength(1);
  const audit = audits[0]!;
  expect(audit).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
  expect(String(audit.target)).toContain(row.id);
  const serialized = text(audit);
  expect(serialized).toContain(NOTE);
  expect(serialized).toContain('revoked');
  expect(JSON.stringify(audit.before)).toContain('processing');
  expect(JSON.stringify(audit.after)).toContain('revoked');
  noPersonalData(audit, b.secrets);
  expect(JSON.stringify(response.json())).not.toContain(NOTE);
  expect(JSON.stringify(d)).not.toContain(NOTE);
  expect(JSON.stringify(await appealRow(s, row.id))).not.toContain(NOTE);
  expect(JSON.stringify(await resolvedEvents(s))).not.toContain(NOTE);
});

it.each(['banned', 'register'] as const satisfies readonly Kind[])(
  '[AC-B1-03ze#55] %s：同一结案请求重放（带同一 Idempotency-Key 也一样）不重复结案：第二次 20902，事件与审计各一条',
  async (kind) => {
    const s = await setup(h, { grants: ALL });
    const { row } = await seed(s, kind);
    const key = { 'idempotency-key': randomUUID() };
    const body = resolution('revoked', 0);
    await appealOf(await s.resolve(row.id, body, await s.issue(), key));
    const after = await snapshot(s);
    await refused(await s.resolve(row.id, body, await s.issue(), key), 20902, CONFLICT);
    await refused(await s.resolve(row.id, body, await s.issue()), 20902, CONFLICT);
    expect(await snapshot(s)).toEqual(after);
    expect(await resolvedEvents(s)).toHaveLength(1);
    expect(await auditsOf(s, 'appeal_resolve')).toHaveLength(1);
  },
);

it.each<[Decision, Decision]>([
  ['upheld', 'revoked'],
  ['revoked', 'upheld'],
  ['revoked', 'revoked'],
  ['upheld', 'upheld'],
])(
  '[AC-B1-03ze#74] 两个账号以同一版本并发结案封禁申诉（%s / %s）：恰好一个成功，另一个 20902；终态、风控、绑定、事件与审计都只按胜者一次',
  async (mine, theirs) => {
    const s = await setup(h, { grants: ALL });
    const other = await colleague(s, { grants: ALL });
    const { row, user } = await seed(s, 'banned');
    const banned = await binding(s, user!.id, { status: 'blocked', blocked_reason: 'ban' });
    // Both step-up tokens are issued first, so the two resolutions race on the appeal alone.
    const myToken = mine === 'revoked' ? await s.issue() : null;
    const theirToken = theirs === 'revoked' ? await other.issue() : null;
    const answers = await Promise.all([
      s.resolve(row.id, resolution(mine, 0), myToken),
      other.resolve(row.id, resolution(theirs, 0), theirToken),
    ]);
    const codes = answers.map((r) => r.json().code).sort((a, b) => a - b);
    expect(codes).toEqual([0, 20902]);
    const winner = answers.findIndex((r) => r.json().code === 0);
    await refused(answers[1 - winner]!, 20902, CONFLICT);
    const decision = winner === 0 ? mine : theirs;
    const resolver = winner === 0 ? s.a.id : other.a.id;
    const d = await appealOf(answers[winner]!);
    expect(d).toMatchObject({ status: decision, handler_id: resolver, row_version: 1 });
    expect(await appealRow(s, row.id)).toMatchObject({
      status: decision,
      handler_id: resolver,
      row_version: 1,
    });
    expect(await riskRow(s, user!.id)).toMatchObject({
      state: decision === 'revoked' ? 'normal' : 'banned',
    });
    expect(await bindingRow(s, banned.id)).toMatchObject(
      decision === 'revoked' ? { status: 'invalid' } : { status: 'blocked', blocked_reason: 'ban' },
    );
    const events = await resolvedEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ appeal_id: row.id, status: decision });
    const audits = await auditsOf(s, 'appeal_resolve');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ admin_id: resolver });
  },
);
