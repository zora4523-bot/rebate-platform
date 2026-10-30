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
const APPEAL = '019a0000-0000-7000-8000-0000000000e1';
const O1 = '019a0000-0000-7000-8000-000000000001';
const O2 = '019a0000-0000-7000-8000-000000000002';
const PENALTY_AT = new Date('2026-09-10T00:00:00.000Z');
const CREATED_AT = new Date('2026-09-20T00:00:00.000Z');
// 2026-09-30T17:00Z is 2026-10-01 01:00 +08:00: the period follows the +08:00 month.
const CLOSED_AT = new Date('2026-09-30T17:00:00.000Z');
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

function harness(appeal: AppealRow | undefined) {
  const queries: CompiledQuery[] = [];
  const connection = new FakeConnection((query) => {
    if (/from "app"\."appeals"/.test(query.sql))
      return { rows: appeal === undefined ? [] : [appeal] };
    if (/insert into "app"\."recon_diffs"/.test(query.sql)) {
      return { rows: [inserted(query)] };
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
    inserts: () =>
      queries.filter((q) => /insert into "app"\."recon_diffs"/.test(q.sql)).map(inserted),
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

function port(shares: readonly AppealRestoreShare[]) {
  return vi.fn<BannedForfeitedSharesPort>(async () => shares);
}

const clock = new FixedClock('2026-10-01T02:00:00.000Z');

it('[B1-03z] 封禁申诉撤销：每份被没收份额登记一条 appeal_restore（R3、+08:00 结案月、ref 含子订单且 ≤64、去重键含 app / 申诉 / 订单 / 用户 / 角色、expected=份额、actual=0、diff=expected−actual）', async () => {
  const h = harness(BANNED);
  const shares = port([
    { orderId: O1, role: 'self', amountFen: 425n, forfeitedAt: T1 },
    { orderId: O2, role: 'direct', amountFen: 85n, forfeitedAt: T2 },
  ]);
  await h.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED));

  expect(shares).toHaveBeenCalledTimes(1);
  expect(shares.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    userId: USER,
    since: PENALTY_AT,
    until: CLOSED_AT,
  });
  const rows = h.inserts();
  expect(rows).toHaveLength(2);
  for (const [row, share] of [
    [rows[0], { order: O1, role: 'self', fen: 425n }],
    [rows[1], { order: O2, role: 'direct', fen: 85n }],
  ] as const) {
    expect(row).toMatchObject({
      app_id: APP,
      type: 'appeal_restore',
      source: 'R3',
      period: '2026-10',
      ref_type: 'order',
      expected_fen: share.fen,
      actual_fen: 0n,
      diff_fen: share.fen,
      status: 'open',
      dedupe_key: `appeal_restore:${APP}:${APPEAL}:${share.order}:${USER}:${share.role}`,
    });
    const refId = String(row?.ref_id);
    expect(refId.startsWith(`${share.order}:${share.role}:`)).toBe(true);
    expect(refId.length).toBeLessThanOrEqual(64);
  }
  expect(rows[0]?.ref_id).not.toBe(rows[1]?.ref_id);
});

it('[B1-03z] 不同会员在同一子订单同一角色上的 ref_id 不同（业务键不撞）', async () => {
  const other = '019a0000-0000-7000-8000-0000000000a2';
  const refs: unknown[] = [];
  for (const user of [USER, other]) {
    const h = harness({ ...BANNED, user_id: user });
    await h.run(
      createAppealRestoreHandler({
        clock,
        shares: port([{ orderId: O1, role: 'direct', amountFen: 85n, forfeitedAt: T1 }]),
      }),
      event({ ...REVOKED, user_id: user, target_id: user }),
    );
    refs.push(h.inserts()[0]?.ref_id);
  }
  expect(refs[0]).not.toBe(refs[1]);
});

it('[B1-03z] 维持、订单申诉、被拦截请求申诉：不读申诉行、不调份额端口、不写', async () => {
  for (const data of [
    { ...REVOKED, status: 'upheld' },
    { ...REVOKED, target_type: 'order', target_id: O1 },
    { ...REVOKED, target_type: 'blocked_request', user_id: null },
  ]) {
    const h = harness(BANNED);
    const shares = port([{ orderId: O1, role: 'self', amountFen: 425n, forfeitedAt: T1 }]);
    await h.run(createAppealRestoreHandler({ clock, shares }), event(data));
    expect(h.queries).toEqual([]);
    expect(shares).not.toHaveBeenCalled();
  }
});

it('[B1-03z] 冻结申诉撤销（prev=frozen）：读申诉行后确认，不调份额端口、不写', async () => {
  const h = harness({ ...BANNED, prev_risk_state: 'frozen' });
  const shares = port([{ orderId: O1, role: 'self', amountFen: 425n, forfeitedAt: T1 }]);
  await h.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED));
  expect(shares).not.toHaveBeenCalled();
  expect(h.inserts()).toEqual([]);
});

it('[B1-03z] 存量申诉（penalty_started_at 为空）：先查申诉提交前的封禁没收，以最近一次的没收时刻为窗口起点', async () => {
  const h = harness({ ...BANNED, penalty_started_at: null });
  const shares = vi.fn<BannedForfeitedSharesPort>(async (_trx, input) =>
    input.until.getTime() === CREATED_AT.getTime()
      ? [
          { orderId: O2, role: 'direct', amountFen: 85n, forfeitedAt: T2 },
          { orderId: O1, role: 'self', amountFen: 425n, forfeitedAt: T1 },
        ]
      : [{ orderId: O2, role: 'direct', amountFen: 85n, forfeitedAt: T2 }],
  );
  await h.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED));
  expect(shares.mock.calls.map((call) => call[1])).toEqual([
    { appId: APP, userId: USER, since: new Date(0), until: CREATED_AT },
    { appId: APP, userId: USER, since: T2, until: CLOSED_AT },
  ]);
  expect(h.inserts()).toHaveLength(1);
});

it('[B1-03z] 存量申诉且申诉前没有封禁没收：不写', async () => {
  const h = harness({ ...BANNED, penalty_started_at: null });
  const shares = port([]);
  await h.run(createAppealRestoreHandler({ clock, shares }), event(REVOKED));
  expect(shares).toHaveBeenCalledTimes(1);
  expect(h.inserts()).toEqual([]);
});

it('[B1-03z] 份额为 0 的不登记', async () => {
  const h = harness(BANNED);
  await h.run(
    createAppealRestoreHandler({
      clock,
      shares: port([
        { orderId: O1, role: 'self', amountFen: 0n, forfeitedAt: T1 },
        { orderId: O2, role: 'direct', amountFen: 85n, forfeitedAt: T2 },
      ]),
    }),
    event(REVOKED),
  );
  expect(h.inserts().map((row) => row.expected_fen)).toEqual([85n]);
});

it('[B1-03z] 事件形状不符、申诉行缺失或与事件不一致、未装配份额端口 → 拒绝，不写', async () => {
  const shares = port([{ orderId: O1, role: 'self', amountFen: 425n, forfeitedAt: T1 }]);
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
    const handler = createAppealRestoreHandler(withPort ? { clock, shares } : { clock });
    await expect(h.run(handler, received)).rejects.toThrow(/^risk: /);
    expect(h.inserts()).toEqual([]);
  }
});
