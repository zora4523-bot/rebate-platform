// B2-04zc 规则测试夹具：经 api 入口（createHttpApp + Fastify inject，注入 FixedClock）读余额流水
// GET /v1/wallet/ledger。订单、提现单、凭证与分录都是合成数据，形状照真实写者：订单类凭证
// biz_type ORDER_CREDIT / ORDER_CLAWBACK / ORDER_ADJUST、biz_id = order_key、带受益人与角色；提现
// 凭证 biz_type withdrawal、biz_id = 提现单号、键 wd:{id}:FREEZE / PAID / RETURN（specs/
// ledger-templates.csv WITHDRAW:*），打款成功凭证只记 frozen 子户（WITHDRAW_PAID / WITHDRAW_FEE /
// TAX_WITHHOLD，零金额分录不写）。分录的 balance_after_fen 与 account_version 照 ledger.post：
// 按记账时刻先后逐张凭证累加，取该子户在凭证之后的余额（BR-FUND-15、16）。期望的条目在各用例里
// 手写，夹具不计算接口的输出，也不调用待测实现。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen, subFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { createRootLogger, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { account, entry, voucher, type Account } from '../../db/ledger/invariants/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { HEADERS, fixture as identityFixture } from '../../identity/token/kit.ts';
import type { Response } from '../../risk/signature/kit.ts';
import { APP, creditedOrder, type Person, type Role } from '../earnings-summary/kit.ts';
import { contract, ROOT } from '../wallet-summary/kit.ts';

export { APP, counterAccount, invitee, ruleVersion } from '../earnings-summary/kit.ts';
export type { Person, Role } from '../earnings-summary/kit.ts';

export const ROUTE = '/v1/wallet/ledger';
export const TIMEOUT = 180_000;
/** 各用例的读取时刻：晚于所有夹具分录。 */
export const NOW = '2026-11-20T04:00:00.000Z';

export type Entry = Schema<'LedgerEntry'>;
export type PostingEntry = Schema<'LedgerPostingEntry'>;
export type PaidEntry = Schema<'LedgerWithdrawPaidEntry'>;
export type LedgerType = PostingEntry['ledger_type'];
export type Link = readonly ['order' | 'withdrawal', string] | null;

// ---------------------------------------------------------------------------------------------
// 期望条目
// ---------------------------------------------------------------------------------------------

/** 一条分录行的期望值：amount 为对可用余额的影响（入账正、扣减负），after 为记账后的可用余额。 */
export function row(
  type: LedgerType,
  subType: string | null,
  amount: number,
  date: string,
  after: number,
  link: Link = null,
  masked = false,
): PostingEntry {
  return {
    ledger_type: type,
    sub_type: subType,
    amount_fen: amount,
    accounting_date: date,
    link_type: link === null ? null : link[0],
    link_id: link === null ? null : link[1],
    masked,
    balance_after_fen: after,
  };
}

/** 邀请分佣类的期望行：masked、不跳转。 */
export function maskedRow(
  type: 'REFERRAL_CREDIT' | 'CLAWBACK' | 'SETTLE_ADJUST',
  subType: string | null,
  amount: number,
  date: string,
  after: number,
): PostingEntry {
  return row(type, subType, amount, date, after, null, true);
}

/** 一张打款成功提现单的 WITHDRAW_PAID 汇总条目：金额为 −实际到账，带税费，不带变动后余额。 */
export function paidRow(
  withdrawalId: string,
  net: number,
  fee: number,
  tax: number,
  date: string,
): PaidEntry {
  return {
    ledger_type: 'WITHDRAW_PAID',
    sub_type: null,
    amount_fen: -net,
    accounting_date: date,
    link_type: 'withdrawal',
    link_id: withdrawalId,
    masked: false,
    balance_after_fen: null,
    fee_fen: fee,
    tax_fen: tax,
  };
}

// ---------------------------------------------------------------------------------------------
// 订单
// ---------------------------------------------------------------------------------------------

export interface Placed {
  /** order_key = {platform}:{sub_order_id}（凭证上的订单键）。 */
  readonly key: string;
  /** orders.order_id（GET /v1/orders/{order_id} 的子订单号）。 */
  readonly id: string;
}

const SYNTHETIC = ':synthetic-';

/** 一笔已入账的子订单（SETTLED / CREDITED）及其分佣快照。 */
export async function placed(
  db: Kysely<DB>,
  rules: string,
  buyer: string,
  people: readonly Person[],
  buyType: 'self' | 'share' = 'self',
): Promise<Placed> {
  const key = await creditedOrder(db, rules, buyer, people, 'taobao', buyType);
  return { key, id: key.slice(key.indexOf(SYNTHETIC) + SYNTHETIC.length) };
}

// ---------------------------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------------------------

type Sub = 'available' | 'frozen';

interface Line {
  readonly sub: Sub;
  readonly type: string;
  readonly subType: string | null;
  /** 对该子户余额的影响（正 = 子户余额增加）；分录 amount_fen 原值取其相反数（BR-FUND-16）。 */
  readonly delta: bigint;
  /** 另记一条同类型、金额相反的平台科目分录。 */
  readonly counter: boolean;
}

interface Plan {
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
  readonly orderKey: string | null;
  readonly role: Role | null;
  readonly kind: string | null;
  /** 记账时刻，写成 +08:00 的 ISO 时刻（YYYY-MM-DDTHH:MM:SS+08:00）；会计日取其前 10 位。 */
  readonly at: string;
  readonly lines: readonly Line[];
}

export interface Ledger {
  readonly user: Account;
  readonly uid: string;
  add(plan: Plan): void;
  /**
   * 写入已登记的凭证：按记账时刻（同一时刻按登记顺序）逐张累加余额与版本，再按登记顺序插入
   * （插入顺序因而可以与时间先后不同）。可多次调用；后一批的时刻不得早于前一批。
   */
  flush(): Promise<void>;
}

/** uid 在 appId 下的 USER_BALANCE 账户（每用户一个）；counter 为同一 app 下的平台科目账户。 */
export async function ledger(
  db: Kysely<DB>,
  uid: string,
  counter: Account,
  appId = APP,
): Promise<Ledger> {
  const user = await account(db, { app_id: appId, owner_id: uid });
  const plans: Plan[] = [];
  let available = 0n;
  let frozen = 0n;
  let version = 0n;
  return {
    user,
    uid,
    add(plan) {
      plans.push(plan);
    },
    async flush() {
      const batch = plans.splice(0, plans.length);
      const states = new Map<Plan, { available: bigint; frozen: bigint; version: bigint }>();
      const chronological = batch
        .map((plan, index) => ({ plan, index }))
        .sort((a, b) => Date.parse(a.plan.at) - Date.parse(b.plan.at) || a.index - b.index);
      for (const { plan } of chronological) {
        for (const line of plan.lines) {
          if (line.sub === 'available') available = addFen(available, line.delta);
          else frozen = addFen(frozen, line.delta);
        }
        version += 1n;
        states.set(plan, { available, frozen, version });
      }
      for (const plan of batch) {
        const state = states.get(plan)!;
        const v = await voucher(db, {
          app_id: appId,
          biz_type: plan.bizType,
          biz_id: plan.bizId,
          uniq_key: plan.uniqKey,
          accounting_date: plan.at.slice(0, 10),
          operator: 'system',
          order_key: plan.orderKey,
          beneficiary_user_id: plan.orderKey === null ? null : uid,
          role: plan.role,
          voucher_kind: plan.kind,
        });
        for (const line of plan.lines) {
          await entry(db, user, v, subFen(0n, line.delta), {
            sub_account: line.sub,
            ledger_type: line.type,
            sub_type: line.subType,
            balance_after_fen: line.sub === 'available' ? state.available : state.frozen,
            account_version: state.version,
            booked_at: plan.at,
          });
          if (line.counter) {
            await entry(db, counter, v, line.delta, {
              ledger_type: line.type,
              sub_type: line.subType,
              booked_at: plan.at,
            });
          }
        }
      }
      await sql`INSERT INTO app.account_balances
          (app_id, account_id, available_fen, frozen_fen, version)
        VALUES (${appId}, ${user.id}, ${available}, ${frozen}, ${version})
        ON CONFLICT (account_id) DO UPDATE SET available_fen = EXCLUDED.available_fen,
          frozen_fen = EXCLUDED.frozen_fen, version = EXCLUDED.version`.execute(db);
    },
  };
}

function availableLine(type: string, subType: string | null, delta: bigint): Line {
  return { sub: 'available', type, subType, delta, counter: true };
}

export interface OrderPosting {
  readonly order: Placed;
  readonly role: Role;
  readonly subType?: string | null;
  /** 对可用余额的影响（入账正、扣减负）。 */
  readonly fen: bigint;
  readonly at: string;
}

/** 首次入账 {order_key}:{uid}:{role}:CREDIT（BR-FUND-05）。 */
export function credit(
  l: Ledger,
  type: 'REBATE_CREDIT' | 'SHARE_CREDIT' | 'REFERRAL_CREDIT',
  p: OrderPosting,
): void {
  l.add({
    uniqKey: `${p.order.key}:${l.uid}:${p.role}:CREDIT`,
    bizType: 'ORDER_CREDIT',
    bizId: p.order.key,
    orderKey: p.order.key,
    role: p.role,
    kind: 'CREDIT',
    at: p.at,
    lines: [availableLine(type, p.subType ?? null, p.fen)],
  });
}

/** 错误更正的红冲 {原 uniq_key}:REVERSE，沿用原分录的类型与 sub_type（BR-FUND-15、16）。 */
export function reverse(
  l: Ledger,
  type: 'REBATE_CREDIT' | 'SHARE_CREDIT' | 'REFERRAL_CREDIT',
  p: OrderPosting,
): void {
  l.add({
    uniqKey: `${p.order.key}:${l.uid}:${p.role}:CREDIT:REVERSE`,
    bizType: 'ORDER_CREDIT',
    bizId: p.order.key,
    orderKey: p.order.key,
    role: p.role,
    kind: 'CREDIT',
    at: p.at,
    lines: [availableLine(type, p.subType ?? null, p.fen)],
  });
}

/** 售后扣回（BR-FUND-08）。 */
export function clawback(l: Ledger, p: OrderPosting): void {
  l.add({
    uniqKey: `${p.order.key}:${l.uid}:${p.role}:CLAWBACK:${randomUUID()}`,
    bizType: 'ORDER_CLAWBACK',
    bizId: p.order.key,
    orderKey: p.order.key,
    role: p.role,
    kind: 'CLAWBACK',
    at: p.at,
    lines: [availableLine('CLAWBACK', p.subType ?? null, p.fen)],
  });
}

/** 结算补差（BR-FUND-09）。 */
export function settleAdjust(l: Ledger, p: OrderPosting): void {
  l.add({
    uniqKey: `${p.order.key}:${l.uid}:${p.role}:ADJ:${randomUUID()}`,
    bizType: 'ORDER_ADJUST',
    bizId: p.order.key,
    orderKey: p.order.key,
    role: p.role,
    kind: 'ADJ',
    at: p.at,
    lines: [availableLine('SETTLE_ADJUST', p.subType ?? null, p.fen)],
  });
}

/** 不关联任何订单或提现单的凭证：人工调账、负余额核销、活动奖励。 */
export function unlinked(
  l: Ledger,
  type: 'ADMIN_ADJUST' | 'BAD_DEBT_WRITEOFF' | 'REWARD',
  subType: string | null,
  fen: bigint,
  at: string,
): void {
  const id = randomUUID();
  const [bizType, uniqKey]: [string, string] =
    type === 'ADMIN_ADJUST'
      ? ['ADMIN_ADJUST', `ADJ:${id}`]
      : type === 'BAD_DEBT_WRITEOFF'
        ? ['BAD_DEBT', `BADDEBT:${l.user.id}:${id}`]
        : ['REWARD', `REWARD:${subType ?? 'none'}:${l.uid}:${id}`];
  l.add({
    uniqKey,
    bizType,
    bizId: id,
    orderKey: null,
    role: null,
    kind: null,
    at,
    lines: [availableLine(type, subType, fen)],
  });
}

export type WithdrawStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'REJECTED' | 'FAILED' | 'PAID_API' | 'PAID_MANUAL';

export interface WithdrawSpec {
  readonly status: WithdrawStatus;
  readonly amount: bigint;
  readonly fee?: bigint;
  readonly tax?: bigint;
  /** 申请（冻结）时刻，+08:00。 */
  readonly appliedAt: string;
  /** 终态时刻（打款成功、驳回或失败），+08:00；在途状态不用。 */
  readonly settledAt?: string;
}

/**
 * 本人的一张提现单（net = amount − fee − tax）及其凭证：申请时 FREEZE（available −amount、frozen
 * +amount）；打款成功时一张 PAID 凭证（frozen 上的 WITHDRAW_PAID −net、WITHDRAW_FEE −fee、
 * TAX_WITHHOLD −tax，零金额不写）；驳回或失败时 RETURN（frozen −amount、available +amount）。
 * 返回提现单号。
 */
export async function withdraw(db: Kysely<DB>, l: Ledger, spec: WithdrawSpec): Promise<string> {
  const id = randomUUID();
  const fee = spec.fee ?? 0n;
  const tax = spec.tax ?? 0n;
  const net = subFen(subFen(spec.amount, fee), tax);
  const paid = spec.status === 'PAID_API' || spec.status === 'PAID_MANUAL';
  const returned = spec.status === 'REJECTED' || spec.status === 'FAILED';
  const settledAt = spec.settledAt ?? spec.appliedAt;
  const appId = l.user.app_id;
  await db
    .withSchema('app')
    .insertInto('withdrawals')
    .values({
      id,
      app_id: appId,
      user_id: l.uid,
      amount_fen: spec.amount,
      fee_fen: fee,
      tax_fen: tax,
      net_fen: net,
      income_type: 'SERVICE_FEE',
      payout_method: 'alipay',
      payout_channel: 'alipay',
      payee_name: '合成收款人',
      payee_account_cipher: Buffer.from('cipher:synthetic.payee@example.test'),
      payee_hmac: randomBytes(32).toString('hex'),
      status: spec.status,
      out_biz_no: randomBytes(16).toString('hex'),
      reject_reason_code: spec.status === 'REJECTED' ? 'USER_REQUEST' : null,
      fail_code: spec.status === 'FAILED' ? 'PAYEE_NOT_EXIST' : null,
      paid_at: paid ? new Date(settledAt) : null,
      manual_entry_by: spec.status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: spec.status === 'PAID_MANUAL' ? randomUUID() : null,
      created_at: new Date(spec.appliedAt),
      updated_at: new Date(settledAt),
    })
    .execute();
  const base = { bizType: 'withdrawal', bizId: id, orderKey: null, role: null, kind: null };
  const own = (sub: Sub, type: string, delta: bigint): Line => ({
    sub,
    type,
    subType: null,
    delta,
    counter: false,
  });
  l.add({
    ...base,
    uniqKey: `wd:${id}:FREEZE`,
    at: spec.appliedAt,
    lines: [
      own('available', 'WITHDRAW_FREEZE', subFen(0n, spec.amount)),
      own('frozen', 'WITHDRAW_FREEZE', spec.amount),
    ],
  });
  if (paid) {
    const parts: [string, bigint][] = [
      ['WITHDRAW_PAID', net],
      ['WITHDRAW_FEE', fee],
      ['TAX_WITHHOLD', tax],
    ];
    l.add({
      ...base,
      uniqKey: `wd:${id}:PAID`,
      at: settledAt,
      lines: parts
        .filter(([, fen]) => fen !== 0n)
        .map(([type, fen]): Line => ({ ...own('frozen', type, subFen(0n, fen)), counter: true })),
    });
  }
  if (returned) {
    l.add({
      ...base,
      uniqKey: `wd:${id}:RETURN`,
      at: settledAt,
      lines: [
        own('frozen', 'WITHDRAW_RETURN', subFen(0n, spec.amount)),
        own('available', 'WITHDRAW_RETURN', spec.amount),
      ],
    });
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

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

export interface Reader {
  readonly me: Caller;
  readonly someone: Caller;
  /** GET /v1/wallet/ledger{query}；caller 缺省为 me，为 null 时不带 Authorization。 */
  get(query?: string, caller?: Caller | null): Promise<Response>;
}

/**
 * 正式 api 入口（真实 AppModule 组装、测试库、不启动队列、不监听端口），时钟固定在 at；
 * 两个已登录用户（me、someone，full 会话）。结束时关闭应用。
 */
export async function withLedger(
  db: Kysely<DB>,
  run: (r: Reader) => Promise<void>,
  at = NOW,
): Promise<void> {
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
        install_secret_cipher: Buffer.from('unused-by-ledger-tests'),
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

type Validate = ReturnType<ReturnType<typeof createValidatorCompiler>>;
// 翻页用例一次读几十页：契约只解析一次，按响应部位缓存编译好的校验函数。
const validators = new Map<'200' | '4XX', Promise<Validate>>();

function validator(part: '200' | '4XX'): Promise<Validate> {
  let found = validators.get(part);
  if (found === undefined) {
    found = contract().then((doc) => {
      const op = doc.paths[ROUTE]?.get as unknown as
        | { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
        | undefined;
      expect(op, `${ROUTE} GET in the contract`).toBeDefined();
      const schema = op!.responses[part]!.content['application/json']!.schema;
      return createValidatorCompiler()({ schema, httpPart: 'body' });
    });
    validators.set(part, found);
  }
  return found;
}

async function expectSchema(part: '200' | '4XX', value: unknown): Promise<void> {
  const validate = await validator(part);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

/** 200 + 契约 LedgerListResponse 校验；返回 data。 */
export async function page(response: Response): Promise<Schema<'LedgerListData'>> {
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<Schema<'LedgerListResponse'>>();
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

/** 只取一页（limit 50）：本用例的条目数不超过一页时即全部流水。 */
export async function everything(r: Reader, caller?: Caller): Promise<Entry[]> {
  const data = await page(await r.get('?limit=50', caller));
  expect(data.next_cursor, 'all entries fit in one page of 50').toBeNull();
  return data.items;
}

/**
 * 从 start（null = 第一页）起按 next_cursor 逐页读到底，返回拼接的条目与页数；每页不超过 limit，
 * 带游标的页不为空。
 */
export async function walk(
  r: Reader,
  limit: number,
  start: string | null = null,
  caller?: Caller,
): Promise<{ items: Entry[]; pages: number }> {
  const items: Entry[] = [];
  let cursor: string | null = start;
  for (let pages = 1; pages <= 200; pages += 1) {
    const query: string =
      cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const data = await page(await r.get(query, caller));
    expect(data.items.length).toBeLessThanOrEqual(limit);
    items.push(...data.items);
    if (data.next_cursor === null) return { items, pages };
    expect(data.items.length, 'a page that has a next_cursor is not empty').toBeGreaterThan(0);
    cursor = data.next_cursor;
  }
  return expect.unreachable('more than 200 pages');
}

/** 本 app 下订单、提现与账务各表的行数及行版本合计：余额流水只读，前后必须一致。 */
export async function footprint(db: Kysely<DB>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of [
    'orders',
    'withdrawals',
    'ledger_accounts',
    'ledger_vouchers',
    'ledger_entries',
    'account_balances',
  ]) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n
      FROM ${sql.table(`app.${table}`)} WHERE app_id = ${APP}`.execute(db);
    result[table] = rows[0]!.n;
  }
  for (const [table, column] of [
    ['orders', 'row_version'],
    ['withdrawals', 'row_version'],
    ['account_balances', 'version'],
  ] as const) {
    const { rows } = await sql<{ n: string }>`SELECT coalesce(sum(${sql.ref(column)}), 0)::text AS n
      FROM ${sql.table(`app.${table}`)} WHERE app_id = ${APP}`.execute(db);
    result[`${table}.${column}`] = rows[0]!.n;
  }
  return result;
}
