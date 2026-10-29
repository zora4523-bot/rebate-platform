// B2-13a 规则测试夹具：经 api 入口（createHttpApp + Fastify inject，注入 FixedClock）读收益看板；
// 订单、分佣快照、凭证与分录都是合成数据。份额基数固定为夹具佣金 1000 扣 15% 预留后的 B = 850
// （BR-CALC-02），本人份额 = floor(850 × ratio_bp / 10000)；期望的笔数与金额在各用例里手写，
// 夹具不计算期间、份额或已结算，也不调用待测实现。
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { subFen } from '@couli/money';
import { sql, type Insertable, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { createRootLogger, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { account, entry, platform, voucher, type Account } from '../../db/ledger/invariants/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { HEADERS, fixture as identityFixture } from '../../identity/token/kit.ts';
import type { Response } from '../../risk/signature/kit.ts';
import { seed, type Person } from '../../settlement/pending-earnings/fixtures.ts';
import { contract, ROOT } from '../wallet-summary/kit.ts';

export type { Person } from '../../settlement/pending-earnings/fixtures.ts';

export const APP = 'couli';
export const ROUTE = '/v1/earnings/summary';
export const TIMEOUT = 120_000;
/** 已入账订单的付款时刻：早于各用例的上月，不进任何期间的付款笔数与预估。 */
export const CREDITED_PAID_AT = '2026-08-03T02:00:00.000Z';

const SWITCHES = ['earnings.dashboard.enabled', 'earnings.dashboard.referral_visible'] as const;
export type DashboardSwitch = (typeof SWITCHES)[number];
export type Role = Person['role'];

/** 本文件测试库里唯一的已发布规则版本（commission_splits 外键所需）。 */
export async function ruleVersion(db: Kysely<DB>): Promise<string> {
  const id = randomUUID();
  const at = new Date('2026-01-01T00:00:13.000Z');
  await db
    .withSchema('app')
    .insertInto('commission_rule_versions')
    .values({
      app_id: APP,
      rule_version_id: id,
      status: 'published',
      effective_from: at,
      indirect_enabled: true,
      created_at: at,
    })
    .execute();
  return id;
}

/** 分录对方的平台科目账户；看板只取用户账户上的分录，这一侧的同类型分录不得计入。 */
export async function counterAccount(db: Kysely<DB>): Promise<Account> {
  const subject = 'UNION_RECEIVABLE:taobao';
  const existing = await db
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select(['id', 'app_id', 'owner_type', 'owner_id', 'subject'])
    .where('app_id', '=', APP)
    .where('owner_type', '=', 'platform')
    .where('owner_id', '=', 'platform')
    .where('subject', '=', subject)
    .executeTakeFirst();
  return existing ?? platform(db, subject, APP);
}

/** 上级为 parentId 的被邀请人（只作订单归属用户与快照里的 self 受益人）。 */
export async function invitee(db: Kysely<DB>, parentId: string): Promise<string> {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: APP,
      nickname: 'synthetic',
      avatar: '',
      invite_code: id,
      attr_code: id,
      level: 'L1',
      register_method: 'sms',
      parent_id: parentId,
      parent_bound_at: new Date('2026-06-01T00:00:00.000Z'),
    })
    .execute();
  return id;
}

export type OrderExtra = Partial<Insertable<DB['orders']>>;

export interface OrderSpec {
  /** orders.user_id（归属用户）；null = 未归因。 */
  readonly buyer: string | null;
  readonly paidAt: string;
  readonly people: readonly Person[];
  readonly buyType?: 'self' | 'share' | null;
  readonly platform?: string;
  readonly platformStatus?: 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID';
  readonly rebateStatus?:
    'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
  readonly extra?: OrderExtra;
}

/** 一笔子订单及其 v1 分佣快照；返回 order_key（{platform}:{sub_order_id}，BR-FUND-05）。 */
export async function order(db: Kysely<DB>, rules: string, spec: OrderSpec): Promise<string> {
  const platformCode = spec.platform ?? 'taobao';
  const paidAt = new Date(spec.paidAt);
  const orderId = await seed(
    db,
    { appId: APP, userId: spec.buyer ?? randomUUID(), ruleVersionId: rules },
    {
      people: spec.people,
      order: {
        platform: platformCode,
        user_id: spec.buyer,
        buy_type: spec.buyType === undefined ? (spec.buyer === null ? null : 'self') : spec.buyType,
        platform_status: spec.platformStatus ?? 'PAID',
        rebate_status: spec.rebateStatus ?? (spec.buyer === null ? 'UNATTRIBUTED' : 'ESTIMATED'),
        attr_at: paidAt,
        paid_at: paidAt,
        ...spec.extra,
      },
    },
  );
  return `${platformCode}:synthetic-${orderId}`;
}

/** 早已付款、已入账的订单（CREDITED / SETTLED），只作入账凭证的 order_key 来源。 */
export function creditedOrder(
  db: Kysely<DB>,
  rules: string,
  buyer: string,
  people: readonly Person[],
  platformCode = 'taobao',
  buyType: 'self' | 'share' = 'self',
): Promise<string> {
  return order(db, rules, {
    buyer,
    paidAt: CREDITED_PAID_AT,
    people,
    platform: platformCode,
    buyType,
    platformStatus: 'SETTLED',
    rebateStatus: 'CREDITED',
  });
}

export interface Books {
  readonly user: Account;
  readonly counter: Account;
}

/** 用户的 USER_BALANCE 账户（每个用户一个）与共用的对方科目。 */
export async function books(db: Kysely<DB>, userId: string, counter: Account): Promise<Books> {
  return { user: await account(db, { app_id: APP, owner_id: userId }), counter };
}

export interface Posting {
  readonly uniqKey: string;
  readonly orderKey: string | null;
  readonly role: Role | null;
  readonly kind: string;
  readonly type: string;
  readonly subType: string | null;
  /** accounting_date（YYYY-MM-DD，+08:00 会计日）。 */
  readonly date: string;
  /** null = 会计日当天 00:00 +08:00。 */
  readonly bookedAt: string | null;
  /** 本人 available 子户分录的 amount_fen 原值：入账（贷记）为负，红冲与扣回为正（BR-FUND-16）。 */
  readonly userFen: bigint;
}

/** 一张两条分录、借贷合计为零的凭证：本人 available 子户一条，对方平台科目一条（同类型）。 */
export async function post(db: Kysely<DB>, b: Books, p: Posting): Promise<void> {
  const v = await voucher(db, {
    app_id: APP,
    biz_type: p.orderKey === null ? 'adjustment' : 'order',
    biz_id: p.orderKey ?? p.uniqKey,
    uniq_key: p.uniqKey,
    accounting_date: p.date,
    order_key: p.orderKey,
    beneficiary_user_id: b.user.owner_id,
    role: p.role,
    voucher_kind: p.kind,
  });
  const line = {
    ledger_type: p.type,
    sub_type: p.subType,
    booked_at: p.bookedAt ?? `${p.date}T00:00:00+08:00`,
  };
  await entry(db, b.user, v, p.userFen, line);
  await entry(db, b.counter, v, subFen(0n, p.userFen), line);
}

export interface CreditInput {
  readonly orderKey: string;
  readonly role: Role;
  readonly type: 'REBATE_CREDIT' | 'SHARE_CREDIT' | 'REFERRAL_CREDIT';
  readonly subType?: 'DIRECT' | 'INDIRECT';
  /** 入账金额（正数，分）。 */
  readonly fen: bigint;
}

/** 首次入账凭证 {order_key}:{uid}:{role}:CREDIT；本人分录记 −fen。 */
export async function credit(
  db: Kysely<DB>,
  b: Books,
  input: CreditInput,
  date: string,
  bookedAt: string | null = null,
): Promise<void> {
  await post(db, b, {
    uniqKey: `${input.orderKey}:${b.user.owner_id}:${input.role}:CREDIT`,
    orderKey: input.orderKey,
    role: input.role,
    kind: 'CREDIT',
    type: input.type,
    subType: input.subType ?? null,
    date,
    bookedAt,
    userFen: subFen(0n, input.fen),
  });
}

/** 错误更正的红冲凭证 {原 uniq_key}:REVERSE，沿用原分录的类型与 sub_type；本人分录记 +fen。 */
export async function reverse(
  db: Kysely<DB>,
  b: Books,
  input: CreditInput,
  date: string,
): Promise<void> {
  await post(db, b, {
    uniqKey: `${input.orderKey}:${b.user.owner_id}:${input.role}:CREDIT:REVERSE`,
    orderKey: input.orderKey,
    role: input.role,
    kind: 'CREDIT',
    type: input.type,
    subType: input.subType ?? null,
    date,
    bookedAt: null,
    userFen: input.fen,
  });
}

export type Switches = Partial<Record<DashboardSwitch, boolean>>;

async function setSwitch(db: Kysely<DB>, key: DashboardSwitch, value: boolean) {
  await db
    .withSchema('app')
    .insertInto('config_items')
    .values({ app_id: APP, key, value, updated_by: 'synthetic-earnings-summary' })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'key'])
        .doUpdateSet({ value, version: sql<number>`app.config_items.version + 1` }),
    )
    .execute();
}

/** 两个开关写回种子缺省值 true（db/seeds/0001_config-defaults.sql）；couli_app 对 config_items 没有 DELETE。 */
async function resetSwitches(db: Kysely<DB>) {
  for (const key of SWITCHES) await setSwitch(db, key, true);
}

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

export interface Caller {
  readonly uid: string;
  readonly device_id: string;
  readonly access_token: string;
}

export interface Dashboard {
  readonly me: Caller;
  readonly someone: Caller;
  /** GET /v1/earnings/summary{query}；caller 为 null 时不带 Authorization。 */
  get(query?: string, caller?: Caller | null): Promise<Response>;
}

/**
 * 正式 api 入口（真实 AppModule 组装、测试库、不启动队列、不监听端口），时钟固定在 at；
 * 两个已登录用户（me、someone）。建应用之前把两个看板开关逐个 upsert 成本测试要的值（未给出的
 * 显式写缺省 true），测试之间不依赖顺序；结束时关闭应用并把开关写回 true。
 */
export async function withDashboard(
  db: Kysely<DB>,
  at: string,
  run: (d: Dashboard) => Promise<void>,
  switches: Switches = {},
): Promise<void> {
  try {
    for (const key of SWITCHES) await setSwitch(db, key, switches[key] ?? true);
    await serve(db, at, run);
  } finally {
    await resetSwitches(db);
  }
}

async function serve(db: Kysely<DB>, at: string, run: (d: Dashboard) => Promise<void>) {
  const deps = identityFixture();
  deps.clock.set(at);
  const login = async (): Promise<Caller> => {
    const device_id = randomUUID();
    await db
      .withSchema('app')
      .insertInto('devices')
      .values({
        id: device_id,
        app_id: APP,
        device_hash: createHash('sha256').update(device_id).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('unused-by-earnings-tests'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: deps.clock.now(),
        created_at: deps.clock.now(),
      })
      .execute();
    const uid = await seedUser(db, APP);
    const issued = await db
      .transaction()
      .execute((trx) => createSession(trx, { uid, app_id: APP, device_id, scp: 'full' }, deps));
    return { uid, device_id, access_token: issued.access_token };
  };
  const me = await login();
  const someone = await login();
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }, { write() {} }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    startQueue: false,
  });
  try {
    await app.init();
    await run({
      me,
      someone,
      get: (query = '', caller: Caller | null = me) =>
        app.inject({
          method: 'GET',
          url: `${ROUTE}${query}`,
          headers: {
            ...HEADERS,
            'x-channel': 'appstore',
            'x-device-id': (caller ?? me).device_id,
            ...(caller === null ? {} : { authorization: `Bearer ${caller.access_token}` }),
          },
        }),
    });
  } finally {
    await app.close();
  }
}

async function expectSchema(part: '200' | '4XX', value: unknown): Promise<void> {
  const doc = await contract();
  const op = doc.paths[ROUTE]?.get as unknown as
    { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } | undefined;
  expect(op, `${ROUTE} GET in the contract`).toBeDefined();
  const schema = op!.responses[part]!.content['application/json']!.schema;
  const validate = createValidatorCompiler()({ schema, httpPart: 'body' });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

/** 200 + 契约 EarningsSummaryResponse 校验；返回 data。 */
export async function summary(response: Response): Promise<Schema<'EarningsSummary'>> {
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<Schema<'EarningsSummaryResponse'>>();
  expect(body).toMatchObject({ code: 0, msg: '' });
  await expectSchema('200', body);
  return body.data;
}

/** 失败信封：HTTP 状态、业务码，并按契约 4XX 校验。 */
export async function refused(response: Response, status: number, code: number): Promise<void> {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
  await expectSchema('4XX', response.json());
}

type Cell = readonly [paidCount: number, estFen: number, creditedFen: number];
type Period = 'today' | 'yesterday' | 'this_month' | 'last_month';

/** 自购或分享栏的期望值；未列出的期间为 0 笔、¥0。 */
export function column(cells: Partial<Record<Period, Cell>> = {}): Schema<'EarningsColumn'> {
  const cell = ([paid_count, est_fen, credited_fen]: Cell = [0, 0, 0]) => ({
    paid_count,
    est_fen,
    credited_fen,
  });
  return {
    today: cell(cells.today),
    yesterday: cell(cells.yesterday),
    this_month: cell(cells.this_month),
    last_month: cell(cells.last_month),
  };
}

type Pair = readonly [estFen: number, creditedFen: number];

/** 邀请栏的期望值：只有本月、上月，各 {est_fen, credited_fen}。 */
export function referral(
  thisMonth: Pair = [0, 0],
  lastMonth: Pair = [0, 0],
): Schema<'ReferralEarnings'> {
  return {
    this_month: { est_fen: thisMonth[0], credited_fen: thisMonth[1] },
    last_month: { est_fen: lastMonth[0], credited_fen: lastMonth[1] },
  };
}

/** 本 app 下订单与账务各表的行数及订单行版本合计：看板只读，前后必须一致。 */
export async function footprint(db: Kysely<DB>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of [
    'orders',
    'commission_split_beneficiary_events',
    'ledger_accounts',
    'ledger_vouchers',
    'ledger_entries',
    'account_balances',
    'config_items',
  ]) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n
      FROM ${sql.table(`app.${table}`)} WHERE app_id = ${APP}`.execute(db);
    result[table] = rows[0]!.n;
  }
  const { rows } = await sql<{ n: string }>`SELECT coalesce(sum(row_version), 0)::text AS n
    FROM app.orders WHERE app_id = ${APP}`.execute(db);
  result['orders.row_version'] = rows[0]!.n;
  return result;
}
