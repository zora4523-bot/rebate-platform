// Unit tests of the appeal restore producer (B1-03z): no database; a fake Kysely driver answers the
// appeals read and the recon_diffs insert by SQL text and records every statement. commission's
// shares port is a fake.
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
import { expect, it, vi } from 'vitest';
import { FixedClock, type ReceivedEvent } from '../../platform/index.ts';
import {
  createAppealRestoreHandler,
  type AppealRestoreShare,
  type BannedForfeitedSharesPort,
  type BannedRunStartPort,
  type ForfeitedAmountPort,
} from './appeal-restore.ts';

type Answer = (query: CompiledQuery) => QueryResult<unknown> | undefined;

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly answer: Answer,
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return (this.answer(query) ?? { rows: [] }) as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const OTHER = '019a0000-0000-7000-8000-0000000000a2';
const APPEAL = '019a0000-0000-7000-8000-0000000000e1';
const O1 = '019a0000-0000-7000-8000-000000000001';
const O2 = '019a0000-0000-7000-8000-000000000002';
const K1 = 'taobao:5550001';
const K2 = 'pdd:7770002';
const PENALTY_AT = new Date('2026-09-10T00:00:00.000Z');
const CREATED_AT = new Date('2026-09-20T00:00:00.000Z');
// 2026-09-30T17:00Z is 2026-10-01 01:00 +08:00: the period follows the +08:00 month.
const CLOSED_AT = new Date('2026-09-30T17:00:00.000Z');
const PREVIOUS_CLOSE = new Date('2026-08-01T00:00:00.000Z');
const T1 = new Date('2026-09-12T00:00:00.000Z');
const T2 = new Date('2026-09-15T00:00:00.000Z');

interface AppealRow {
  target_type: string;
  user_id: string | null;
  status: string;
  prev_risk_state: string | null;
  penalty_started_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
}

const BANNED: AppealRow = {
  target_type: 'account',
  user_id: USER,
  status: 'revoked',
  prev_risk_state: 'banned',
  penalty_started_at: PENALTY_AT,
  closed_at: CLOSED_AT,
  created_at: CREATED_AT,
};

const INSERT = /insert into "app"\."recon_diffs"/;

/**
 * Fake database: the appeal row, the previous-appeal close, and recon_diffs whose business key
 * (ref_id; one app, type and period here) may already be held by `occupied` (another dedupe key).
 */
function harness(
  appeal: AppealRow | undefined,
  opts: { occupied?: readonly string[]; previousClose?: Date | null } = {},
) {
  const queries: CompiledQuery[] = [];
  const stored: Record<string, unknown>[] = (opts.occupied ?? []).map((ref) => ({
    ref_id: ref,
    dedupe_key: 'someone-else',
  }));
  const connection = new FakeConnection((query) => {
    if (/from "app"\."appeals"/.test(query.sql)) {
      if (query.sql.includes('max(')) return { rows: [{ closed_at: opts.previousClose ?? null }] };
      return { rows: appeal === undefined ? [] : [appeal] };
    }
    if (INSERT.test(query.sql)) {
      const row = inserted(query);
      const taken = stored.some((r) => r.ref_id === row.ref_id || r.dedupe_key === row.dedupe_key);
      if (taken) return { rows: [] };
      stored.push(row);
      return { rows: [row] };
    }
    if (/from "app"\."recon_diffs"/.test(query.sql)) {
      const params = query.parameters as unknown[];
      // dedupe lookup: (app_id, dedupe_key); business key lookup: (app_id, type, period, ref_id).
      const hit = query.sql.includes('"dedupe_key" =')
        ? stored.find((r) => r.dedupe_key === params[1])
        : stored.find((r) => r.ref_id === params[3]);
      return { rows: hit === undefined ? [] : [hit] };
    }
    return undefined;
  }, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    queries,
    stored: () => stored.filter((r) => r.dedupe_key !== 'someone-else'),
    run: (handler: ReturnType<typeof createAppealRestoreHandler>, event: ReceivedEvent) =>
      db.transaction().execute((trx) => handler(event, trx)),
  };
}

/** The inserted row: the column list of the INSERT zipped with its parameters. */
function inserted(query: CompiledQuery): Record<string, unknown> {
  const columns = /\(([^)]*)\) values/.exec(query.sql)?.[1] ?? '';
  const names = columns.split(',').map((c) => c.trim().replaceAll('"', ''));
  return Object.fromEntries(names.map((name, i) => [name, query.parameters[i]]));
}

function resolutionOf(row: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = row?.resolution;
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function event(data: Record<string, unknown>, name = 'appeal.resolved'): ReceivedEvent {
  return {
    eventId: '019a0000-0000-7000-8000-0000000000f1',
    appId: APP,
    name,
    version: 1,
    occurredAt: CLOSED_AT.toISOString(),
    payload: data as ReceivedEvent['payload'],
    consumer: 'risk-appeal-restore',
    attempt: 1,
  };
}

const REVOKED = {
  app_id: APP,
  appeal_id: APPEAL,
  user_id: USER,
  target_type: 'account',
  target_id: USER,
  status: 'revoked',
  need_reauth: true,
};

function share(orderId: string, orderKey: string, role: string, at: Date): AppealRestoreShare {
  // amountFen is commission's snapshot estimate: deliberately different from the booked amount.
  return { orderId, orderKey, role, amountFen: 425n, forfeitedAt: at };
}

function port(shares: readonly AppealRestoreShare[]) {
  return vi.fn<BannedForfeitedSharesPort>(async () => shares);
}

/** FORFEIT voucher amounts by `${orderKey}|${role}`. */
function amounts(table: Record<string, bigint | null>) {
  return vi.fn<ForfeitedAmountPort>(async (_trx, input) => {
    const value = table[`${input.orderKey}|${input.role}`];
    return value === undefined ? null : value;
  });
}

const clock = new FixedClock('2026-10-01T02:00:00.000Z');

it('[B1-03z r2] 金额取 FORFEIT 凭证实际没收额（预估 425、按结算没收 510 → 登记 510）；ref_id = 订单键；R3、+08:00 结案月；去重键含 app / 申诉 / 订单 / 用户 / 角色', async () => {
  const h = harness(BANNED);
  const shares = port([share(O1, K1, 'self', T1), share(O2, K2, 'direct', T2)]);
  const forfeitedAmount = amounts({ [`${K1}|self`]: 510n, [`${K2}|direct`]: 85n });
  await h.run(createAppealRestoreHandler({ clock, shares, forfeitedAmount }), event(REVOKED));

  expect(shares.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    userId: USER,
    since: PENALTY_AT,
    until: CLOSED_AT,
  });
  expect(forfeitedAmount.mock.calls.map((call) => call[1])).toEqual([
    { appId: APP, orderKey: K1, userId: USER, role: 'self' },
    { appId: APP, orderKey: K2, userId: USER, role: 'direct' },
  ]);
  const rows = h.stored();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    app_id: APP,
    type: 'appeal_restore',
    source: 'R3',
    period: '2026-10',
    ref_type: 'order',
    ref_id: K1,
    expected_fen: 510n,
    actual_fen: 0n,
    diff_fen: 510n,
    status: 'open',
    dedupe_key: `appeal_restore:${APP}:${APPEAL}:${O1}:${USER}:self`,
  });
  expect(rows[1]).toMatchObject({ ref_id: K2, expected_fen: 85n, diff_fen: 85n });
  expect(resolutionOf(rows[0])).toMatchObject({
    order_key: K1,
    shares: [{ role: 'self', amount_fen: '510', forfeited_at: T1.toISOString() }],
  });
});

it('[B1-03z r2] 同一用户同一子订单的多个角色合成一条：金额为各角色之和，resolution 列明细', async () => {
  const h = harness(BANNED);
  await h.run(
    createAppealRestoreHandler({
      clock,
      shares: port([share(O1, K1, 'self', T1), share(O1, K1, 'direct', T2)]),
      forfeitedAmount: amounts({ [`${K1}|self`]: 510n, [`${K1}|direct`]: 85n }),
    }),
    event(REVOKED),
  );
  const rows = h.stored();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ref_id: K1,
    expected_fen: 595n,
    dedupe_key: `appeal_restore:${APP}:${APPEAL}:${O1}:${USER}:direct+self`,
  });
  expect(resolutionOf(rows[0]).shares).toEqual([
    { role: 'direct', amount_fen: '85', forfeited_at: T2.toISOString() },
    { role: 'self', amount_fen: '510', forfeited_at: T1.toISOString() },
  ]);
});

it('[B1-03z r2] 业务键已被别的差错单占用（同订单、同月）→ 改用会员专属 ref_id 登记，不合并丢钱', async () => {
  const h = harness(BANNED, { occupied: [K1] });
  await h.run(
    createAppealRestoreHandler({
      clock,
      shares: port([share(O1, K1, 'direct', T1)]),
      forfeitedAmount: amounts({ [`${K1}|direct`]: 85n }),
    }),
    event(REVOKED),
  );
  const rows = h.stored();
  expect(rows).toHaveLength(1);
  expect(String(rows[0]?.ref_id)).toMatch(/^taobao:5550001#[0-9a-f]{12}$/);
  expect(rows[0]).toMatchObject({ expected_fen: 85n });
});

it('[B1-03z r2] 不同会员在同一子订单上的专属 ref_id 不同', async () => {
  const refs: unknown[] = [];
  for (const user of [USER, OTHER]) {
    const h = harness({ ...BANNED, user_id: user }, { occupied: [K1] });
    await h.run(
      createAppealRestoreHandler({
        clock,
        shares: port([share(O1, K1, 'direct', T1)]),
        forfeitedAmount: amounts({ [`${K1}|direct`]: 85n }),
      }),
      event({ ...REVOKED, user_id: user, target_id: user }),
    );
    refs.push(h.stored()[0]?.ref_id);
  }
  expect(refs[0]).not.toBe(refs[1]);
});

it('[B1-03z r2] 拿不到没收金额（未注入端口或无 FORFEIT 凭证）→ 拒绝并记 error，不回落到快照值、不写', async () => {
  for (const forfeitedAmount of [undefined, amounts({})]) {
    const h = harness(BANNED);
    const errors: Array<[Record<string, unknown>, string]> = [];
    const handler = createAppealRestoreHandler({
      clock,
      shares: port([share(O1, K1, 'self', T1)]),
      ...(forfeitedAmount === undefined ? {} : { forfeitedAmount }),
      logger: { error: (fields, message) => errors.push([fields, message]) },
    });
    await expect(h.run(handler, event(REVOKED))).rejects.toThrow('forfeited amount');
    expect(h.queries.filter((q) => INSERT.test(q.sql))).toEqual([]);
    expect(errors.map(([, message]) => message)).toEqual(['appeal_restore_amount_unavailable']);
  }
});

it('[B1-03z r2] 没收金额为 0 的角色不登记', async () => {
  const h = harness(BANNED);
  await h.run(
    createAppealRestoreHandler({
      clock,
      shares: port([share(O1, K1, 'self', T1), share(O2, K2, 'direct', T2)]),
      forfeitedAmount: amounts({ [`${K1}|self`]: 0n, [`${K2}|direct`]: 85n }),
    }),
    event(REVOKED),
  );
  expect(h.stored().map((row) => row.ref_id)).toEqual([K2]);
});

it('[B1-03z] 维持、订单申诉、被拦截请求申诉：不读申诉行、不调端口、不写', async () => {
  for (const data of [
    { ...REVOKED, status: 'upheld' },
    { ...REVOKED, target_type: 'order', target_id: O1 },
    { ...REVOKED, target_type: 'blocked_request', user_id: null },
  ]) {
    const h = harness(BANNED);
    const shares = port([share(O1, K1, 'self', T1)]);
    await h.run(createAppealRestoreHandler({ clock, shares }), event(data));
    expect(h.queries).toEqual([]);
    expect(shares).not.toHaveBeenCalled();
  }
});

it('[B1-03z] 冻结申诉撤销（prev=frozen）：读申诉行后确认，不调份额端口、不写', async () => {
  const h = harness({ ...BANNED, prev_risk_state: 'frozen' });
  const shares = port([share(O1, K1, 'self', T1)]);
  await h.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED));
  expect(shares).not.toHaveBeenCalled();
  expect(h.stored()).toEqual([]);
});

it('[B1-03z r2 存量申诉] penalty_started_at 为空：以 commission 的连续封禁段起点为窗口起点，下界是上一次结束封禁 / 冻结的申诉结案时刻', async () => {
  const h = harness({ ...BANNED, penalty_started_at: null }, { previousClose: PREVIOUS_CLOSE });
  const runStart = new Date('2026-09-11T00:00:00.000Z');
  const bannedRunStart = vi.fn<BannedRunStartPort>(async () => runStart);
  const shares = port([share(O1, K1, 'self', T1)]);
  await h.run(
    createAppealRestoreHandler({
      clock,
      shares,
      bannedRunStart,
      forfeitedAmount: amounts({ [`${K1}|self`]: 510n }),
    }),
    event(REVOKED),
  );
  expect(bannedRunStart.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    userId: USER,
    until: CREATED_AT,
    notBefore: PREVIOUS_CLOSE,
  });
  expect(shares.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    userId: USER,
    since: runStart,
    until: CLOSED_AT,
  });
  const previous = h.queries.find(
    (q) => /from "app"\."appeals"/.test(q.sql) && q.sql.includes('max('),
  );
  expect(previous?.sql).toContain('"closed_at" <');
  expect(previous?.sql).toContain('not (');
  expect(h.stored()).toHaveLength(1);
});

it('[B1-03z r2 存量申诉] 没有连续封禁段 → 不写；未注入段起点端口 → 拒绝', async () => {
  const h = harness({ ...BANNED, penalty_started_at: null });
  const shares = port([share(O1, K1, 'self', T1)]);
  await h.run(
    createAppealRestoreHandler({ clock, shares, bannedRunStart: async () => null }),
    event(REVOKED),
  );
  expect(shares).not.toHaveBeenCalled();
  const h2 = harness({ ...BANNED, penalty_started_at: null });
  await expect(
    h2.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED)),
  ).rejects.toThrow('banned run port');
});

it('[B1-03z] 事件形状不符、申诉行缺失或与事件不一致、未装配份额端口 → 拒绝，不写', async () => {
  const shares = port([share(O1, K1, 'self', T1)]);
  const forfeitedAmount = amounts({ [`${K1}|self`]: 510n });
  const cases: Array<[AppealRow | undefined, ReceivedEvent, boolean]> = [
    [BANNED, event(REVOKED, 'risk.state_changed'), true],
    [BANNED, event({ ...REVOKED, app_id: 'other' }), true],
    [BANNED, event({ ...REVOKED, appeal_id: 7 }), true],
    [BANNED, event({ ...REVOKED, status: 'processing' }), true],
    [BANNED, event({ ...REVOKED, user_id: null }), true],
    [undefined, event(REVOKED), true],
    [{ ...BANNED, user_id: '019a0000-0000-7000-8000-0000000000a9' }, event(REVOKED), true],
    [{ ...BANNED, status: 'upheld' }, event(REVOKED), true],
    [BANNED, event(REVOKED), false],
  ];
  for (const [row, received, withPort] of cases) {
    const h = harness(row);
    const handler = createAppealRestoreHandler(
      withPort ? { clock, shares, forfeitedAmount } : { clock, forfeitedAmount },
    );
    await expect(h.run(handler, received)).rejects.toThrow(/^risk: /);
    expect(h.stored()).toEqual([]);
  }
});
