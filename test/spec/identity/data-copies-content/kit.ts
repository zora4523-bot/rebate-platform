// B1-27f rule-test fixture (08 BR-ID-40 细则「导出范围（默认）」, BR-ID-30 ①, BR-ID-33; brief §9). The
// subject of the tests is app.module's personalDataCopySources(clock, crypto): identity's
// PersonalDataCopySources over the owners' read-only files, each reached through its index.ts
// (imported at run time: those files carry Nest decorators). Types come from the erasable files.
//
// world() seeds one fresh app over the business role couli_app: the member A (phone, two
// third-party logins, a verified real name, consents, orders, a ledger credit, two withdrawals,
// Agent sessions), A's inviter P, A's invitee C, another member O of the same app with data of
// every kind, a member N with nothing bound, a guest session on A's device, and the console account
// that handled the Agent reports and the withdrawals. Ciphers are made
// with a local FieldCrypto under the contexts the writers use. The copy is read on a READ ONLY
// transaction, so any write of a source fails the test.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, type DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type KyselyPlugin,
  type Transaction,
} from 'kysely';
import {
  createLedger,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type {
  PersonalDataCopyAccount,
  PersonalDataCopyAgentConversation,
  PersonalDataCopyConsent,
  PersonalDataCopyInvite,
  PersonalDataCopyLedgerEntry,
  PersonalDataCopyOrder,
  PersonalDataCopyRealname,
  PersonalDataCopySources,
  PersonalDataCopySubject,
  PersonalDataCopyWithdrawal,
} from '../../../../apps/api/src/modules/identity/ports/personal-data-copy-sources.ts';

interface TestDatabaseUrls {
  urlFor(role: string): string;
}

export const ROOT = new URL('../../../../', import.meta.url);
/** 2026-10-24 12:00 +08:00. */
export const NOW = '2026-10-24T04:00:00.000Z';
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** FieldCrypto contexts of the writers (identity registration / realname, the payout bindings). */
export const CONTEXT = Object.freeze({
  phone: 'users.phone',
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
  alipay: 'payout_accounts.alipay',
  bankCard: 'payout_accounts.bank_card',
});

export const PHONE = '13800138000';
export const NICKNAME = '小狸';
export const REGISTERED_AT_MS = -100 * DAY_MS;
export const REAL_NAME = '张小三';
export const ID_NO = '11010119900307123X';
export const BIRTH_DATE = '1990-03-07';
/** BR-ID-33: 姓名只显示末字, 身份证首 1 位 + 末 1 位. */
export const MASKED_NAME = '**三';
export const MASKED_ID_NO = `1${'*'.repeat(16)}X`;
export const VERIFIED_AT_MS = -20 * DAY_MS;
export const ALIPAY = 'zhangsan@example.com';
export const MASKED_ALIPAY = 'zh***@example.com';
export const CARD_NO = '6222021234567890123';
export const MASKED_CARD = '尾号 0123';
export const PAYEE_NAME = REAL_NAME;
/**
 * The signed amount of A's own entry of the credit voucher (a liability: a credit is negative,
 * BR-FUND-16, available = -sum); the platform's counter-entry of the same voucher is -CREDIT_FEN.
 */
export const CREDIT_FEN = -1234n;

/** Instant `ms` after NOW. */
export function at(ms: number): Date {
  return new Date(Date.parse(NOW) + ms);
}

export function hex(): string {
  return randomBytes(32).toString('hex');
}

// ---- the code under test (run-time imports) ----------------------------------------------------

type IdentityCopyApi =
  typeof import('../../../../apps/api/src/modules/identity/application/personal-data-copy-sources.ts');
type OrdersCopyApi =
  typeof import('../../../../apps/api/src/modules/orders/application/personal-data-copy-read.ts');
type LedgerCopyApi =
  typeof import('../../../../apps/api/src/modules/ledger/application/personal-data-copy-read.ts');
type PayoutCopyApi =
  typeof import('../../../../apps/api/src/modules/payout/application/personal-data-copy-read.ts');
type AgentCopyApi =
  typeof import('../../../../apps/api/src/modules/agent/application/personal-data-copy-read.ts');
type GrowthCopyApi =
  typeof import('../../../../apps/api/src/modules/growth/application/personal-data-copy-read.ts');

export interface AppAssembly {
  personalDataCopySources(clock: FixedClock, crypto: FieldCrypto): PersonalDataCopySources;
}

async function load<T>(path: string): Promise<T> {
  return (await import(new URL(path, ROOT).href)) as T;
}

/** identity's public surface (index.ts) as far as this task goes. */
export function identity(): Promise<IdentityCopyApi> {
  return load<IdentityCopyApi>('apps/api/src/modules/identity/index.ts');
}

/** The five owners' read-only exports, each through its own index.ts. */
export async function owners() {
  return {
    orders: await load<OrdersCopyApi>('apps/api/src/modules/orders/index.ts'),
    ledger: await load<LedgerCopyApi>('apps/api/src/modules/ledger/index.ts'),
    payout: await load<PayoutCopyApi>('apps/api/src/modules/payout/index.ts'),
    agent: await load<AgentCopyApi>('apps/api/src/modules/agent/index.ts'),
    growth: await load<GrowthCopyApi>('apps/api/src/modules/growth/index.ts'),
  };
}

export function appModule(): Promise<AppAssembly> {
  return load<AppAssembly>('apps/api/src/app.module.ts');
}

export async function fieldCrypto(): Promise<FieldCrypto> {
  const provider = new LocalKeyProvider(randomBytes(32));
  return openFieldCrypto(await createWrappedKeyring(provider), provider);
}

/** payout's DecryptWithdrawalAccount over `crypto` (the payout_accounts.* contexts). */
export function withdrawalDecrypt(crypto: FieldCrypto) {
  return (cipher: Buffer, method: string): string => {
    const context =
      method === 'alipay' ? CONTEXT.alipay : method === 'bank_card' ? CONTEXT.bankCard : null;
    if (context === null) throw new Error('fixture: no cipher context for the payout method');
    return crypto.decrypt(cipher.toString('utf8'), context);
  };
}

// ---- reading a copy ------------------------------------------------------------------------------

export interface Copy {
  readonly account: PersonalDataCopyAccount | null;
  readonly realname: PersonalDataCopyRealname;
  readonly consents: readonly PersonalDataCopyConsent[];
  readonly orders: readonly PersonalDataCopyOrder[];
  readonly ledger: readonly PersonalDataCopyLedgerEntry[];
  readonly withdrawals: readonly PersonalDataCopyWithdrawal[];
  readonly agent: readonly PersonalDataCopyAgentConversation[];
  readonly invite: PersonalDataCopyInvite;
}

export const SECTIONS = [
  'account',
  'realname',
  'consents',
  'orders',
  'ledger',
  'withdrawals',
  'agent',
  'invite',
] as const;
export type Section = (typeof SECTIONS)[number];

/** Every section of the copy, one after the other on `handle`. */
export async function collect(
  sources: PersonalDataCopySources,
  handle: Kysely<DB>,
  subject: PersonalDataCopySubject,
): Promise<Copy> {
  return {
    account: await sources.account(handle, subject),
    realname: await sources.realname(handle, subject),
    consents: await sources.consents(handle, subject),
    orders: await sources.orders(handle, subject),
    ledger: await sources.ledger(handle, subject),
    withdrawals: await sources.withdrawals(handle, subject),
    agent: await sources.agent(handle, subject),
    invite: await sources.invite(handle, subject),
  };
}

/** Runs on a READ ONLY transaction of `db`: a write in there fails with 25006. */
export function readOnly<T>(db: Kysely<DB>, run: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().setAccessMode('read only').execute(run);
}

/** The copy as text (bigint as decimal, Date as ISO), to look for values that must not be in it. */
export function text(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

export function byKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((left, right) => key(left).localeCompare(key(right)));
}

// ---- statements ----------------------------------------------------------------------------------

/** A handle that records every statement it compiles (SQL and parameters) before running it. */
export function observe(executor: Kysely<DB>) {
  const statements: CompiledQuery[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      statements.push(executor.getExecutor().compileQuery(node, queryId));
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { handle: executor.withPlugin(plugin), statements };
}

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A Kysely that compiles and records every statement but never connects (every read is empty). */
export function compileOnlyDb(statements: Statement[]): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
}

/** A plain read: a SELECT (or WITH … SELECT) without a locking clause or an advisory lock. */
export function isPlainRead(statement: Statement): boolean {
  return (
    /^\s*\(?\s*(select|with)\b/i.test(statement.sql) &&
    !/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(statement.sql) &&
    !/advisory|\b(insert|update|delete|merge|truncate)\b\s/i.test(
      statement.sql.replace(/"[^"]*"/g, '""'),
    )
  );
}

/** The statement binds `value` as a parameter (an array parameter counts by its items). */
export function binds(statement: Statement, value: string): boolean {
  return statement.parameters.flat().some((parameter) => String(parameter) === value);
}

// ---- the kit -------------------------------------------------------------------------------------

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const crypto = await fieldCrypto();
  const clock = new FixedClock(NOW);
  return {
    db,
    crypto,
    clock,
    /** app.module's assembly (call it in the test body: NotImplemented must fail each test). */
    async sources(): Promise<PersonalDataCopySources> {
      return (await appModule()).personalDataCopySources(clock, crypto);
    },
  };
}
export type Kit = Awaited<ReturnType<typeof open>>;

export async function close(kit: Kit | undefined) {
  await kit?.db.destroy();
}

// ---- seeding -------------------------------------------------------------------------------------

export interface Person {
  readonly appId: string;
  readonly uid: string;
  readonly nickname: string;
  readonly phone: string | null;
  readonly inviteCode: string;
  readonly subject: PersonalDataCopySubject;
}

async function person(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  appId: string,
  options: {
    readonly nickname: string;
    readonly phone: string | null;
    readonly parentId: string | null;
    readonly createdAt: Date;
  },
): Promise<Person> {
  const uid = randomUUID();
  const inviteCode = `inv${randomBytes(5).toString('hex')}`;
  const cipher =
    options.phone === null
      ? null
      : Buffer.from(crypto.encrypt(options.phone, CONTEXT.phone), 'utf8');
  const parent = options.parentId;
  await sql`INSERT INTO app.users
    (id, app_id, phone_cipher, phone_hmac, nickname, avatar, invite_code, attr_code, level,
     register_method, parent_id, parent_bind_source, parent_bound_at, created_at, updated_at)
    VALUES (${uid}, ${appId}, ${cipher}, ${options.phone === null ? null : hex()},
      ${options.nickname}, 'https://example.test/avatar.png', ${inviteCode},
      ${`attr${randomBytes(5).toString('hex')}`}, 'L1', 'sms', ${parent},
      ${parent === null ? null : 'register'}, ${parent === null ? null : options.createdAt},
      ${options.createdAt}, ${options.createdAt})`.execute(db);
  return {
    appId,
    uid,
    nickname: options.nickname,
    phone: options.phone,
    inviteCode,
    subject: { appId, userId: uid },
  };
}

async function oauth(db: Kysely<DB>, p: Person, provider: 'wechat' | 'apple') {
  await sql`INSERT INTO app.user_oauth (id, app_id, user_id, provider, union_id, created_at,
      updated_at)
    VALUES (${randomUUID()}, ${p.appId}, ${p.uid}, ${provider}, ${`union-${randomUUID()}`},
      ${at(-90 * DAY_MS)}, ${at(-90 * DAY_MS)})`.execute(db);
}

async function realname(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  p: Person,
  name: string,
  idNo: string,
  birthDate: string,
) {
  const cipher = (value: string, context: string) =>
    Buffer.from(crypto.encrypt(value, context), 'utf8');
  await sql`INSERT INTO app.realname (id, app_id, user_id, name_cipher, id_no_cipher, id_no_hmac,
      birth_date_cipher, status, provider, verified_at, created_at, updated_at)
    VALUES (${randomUUID()}, ${p.appId}, ${p.uid}, ${cipher(name, CONTEXT.name)},
      ${cipher(idNo, CONTEXT.idNo)}, ${hex()}, ${cipher(birthDate, CONTEXT.birthDate)}, 'verified',
      'fixture-provider', ${at(VERIFIED_AT_MS)}, ${at(VERIFIED_AT_MS)},
      ${at(VERIFIED_AT_MS)})`.execute(db);
}

/** The console account that handled the reports (agent_messages.report_handler_id references it). */
async function admin(db: Kysely<DB>, appId: string, adminId: string) {
  await sql`INSERT INTO app.admin_users (id, app_id, login_name, password_hash, is_super, status,
      created_at, updated_at)
    VALUES (${adminId}, ${appId}, ${`pdc_${adminId}`}, 'synthetic-unused', false, 'active',
      ${at(-365 * DAY_MS)}, ${at(-365 * DAY_MS)})`.execute(db);
}

async function device(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.devices
    (id, app_id, device_hash, id_source, install_secret_cipher, platform, app_version, last_seen_at)
    VALUES (${id}, ${appId}, ${hex()}, 'idfv', ${Buffer.from(`install-secret-${id}`)}, 'ios',
      '2.0.0', ${at(-DAY_MS)})`.execute(db);
  return id;
}

async function userConsent(
  db: Kysely<DB>,
  p: Person,
  row: Omit<PersonalDataCopyConsent, 'server_at'>,
): Promise<PersonalDataCopyConsent> {
  const serverAt = new Date(row.client_at.getTime() + 1_000);
  await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, type, version, channel,
      accepted, client_at, server_at, created_at)
    VALUES (${p.appId}, 'user', ${p.uid}, ${row.type}, ${row.version}, ${row.channel},
      ${row.accepted}, ${row.client_at}, ${serverAt}, ${serverAt})`.execute(db);
  return { ...row, server_at: serverAt };
}

async function deviceConsent(db: Kysely<DB>, appId: string, deviceId: string) {
  await sql`INSERT INTO app.consent_records (app_id, subject_type, device_id, type, version,
      channel, accepted, client_at, server_at, created_at)
    VALUES (${appId}, 'device', ${deviceId}, 'privacy', 7, 'first_launch', true,
      ${at(-120 * DAY_MS)}, ${at(-120 * DAY_MS)}, ${at(-120 * DAY_MS)})`.execute(db);
}

async function order(
  db: Kysely<DB>,
  p: Person,
  options: { readonly title: string; readonly payFen: number; readonly ageMs: number },
): Promise<PersonalDataCopyOrder> {
  const orderId = randomUUID();
  const subOrderId = `c${randomUUID().replaceAll('-', '')}`;
  const attrAt = at(-options.ageMs);
  const paidAt = at(-options.ageMs + MINUTE_MS);
  const createdAt = at(-options.ageMs + 2 * MINUTE_MS);
  await sql`INSERT INTO app.order_keys (order_id, app_id, platform, sub_order_id, attr_at,
      created_at)
    VALUES (${orderId}, ${p.appId}, 'jd', ${subOrderId}, ${attrAt}, ${createdAt})`.execute(db);
  await sql`INSERT INTO app.orders (order_id, app_id, platform, sub_order_id, raw_item_id, title,
      pay_amount_fen, user_id, platform_status, rebate_status, paid_at, attr_at, created_at,
      updated_at)
    VALUES (${orderId}, ${p.appId}, 'jd', ${subOrderId}, 'synthetic-item', ${options.title},
      ${options.payFen}, ${p.uid}, 'PAID', 'ESTIMATED', ${paidAt}, ${attrAt}, ${createdAt},
      ${createdAt})`.execute(db);
  return {
    order_id: orderId,
    platform: 'jd',
    sub_order_id: subOrderId,
    title: options.title,
    pay_amount_fen: BigInt(options.payFen),
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
    paid_at: paidAt,
    created_at: createdAt,
  };
}

function voucher(appId: string, accountId: string, signedUserAmount: bigint): PostingVoucher {
  return {
    appId,
    uniqKey: `POST:${randomUUID()}`,
    bizType: 'TEST_POSTING',
    bizId: randomUUID(),
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: [
      {
        account: { ownerType: 'user', accountId },
        sub_account: 'available',
        amount_fen: signedUserAmount,
        ledger_type: 'REBATE_CREDIT',
        sub_type: null,
        income_type: 'SERVICE_FEE',
      },
      {
        account: { ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' },
        sub_account: 'available',
        amount_fen: -signedUserAmount,
        ledger_type: 'REBATE_CREDIT',
        sub_type: null,
        income_type: null,
      },
    ],
  };
}

/**
 * One credit voucher to the user, booked at NOW: the user's entry is `signedUserAmount` (negative:
 * available rises by its magnitude, as test/spec/ledger/posting books a credit) and the platform's
 * counter-entry is its negation.
 */
async function credit(db: Kysely<DB>, p: Person, signedUserAmount: bigint) {
  const ledger = createLedger({ clock: new FixedClock(NOW) });
  const account = await db
    .transaction()
    .execute((trx) => ledger.openUserAccount(trx, { appId: p.appId, userId: p.uid }));
  await db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId: p.appId, userIds: [p.uid] });
    await ledger.post(trx, voucher(p.appId, account.account_id, signedUserAmount));
  });
}

async function withdrawal(
  db: Kysely<DB>,
  crypto: FieldCrypto,
  p: Person,
  options: {
    readonly method: 'alipay' | 'bank_card';
    readonly account: string;
    readonly payeeName: string;
    readonly paid: boolean;
    readonly adminId: string;
    readonly ageMs: number;
  },
): Promise<Omit<PersonalDataCopyWithdrawal, 'masked_account'>> {
  const id = randomUUID();
  const createdAt = at(-options.ageMs);
  const reviewedAt = at(-options.ageMs + 10 * MINUTE_MS);
  const paidAt = options.paid ? at(-options.ageMs + 20 * MINUTE_MS) : null;
  const context = options.method === 'alipay' ? CONTEXT.alipay : CONTEXT.bankCard;
  const cipher = Buffer.from(crypto.encrypt(options.account, context), 'utf8');
  const status = options.paid ? 'PAID_API' : 'PENDING_REVIEW';
  await sql`INSERT INTO app.withdrawals (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen,
      income_type, payout_method, payee_name, payee_account_cipher, payee_hmac, bank_name, status,
      out_biz_no, payout_channel, reviewer_id, reviewed_at, executor_id, executed_at, paid_at,
      created_at, updated_at)
    VALUES (${id}, ${p.appId}, ${p.uid}, 10000, 100, 0, 9900, 'SERVICE_FEE', ${options.method},
      ${options.payeeName}, ${cipher}, ${hex()},
      ${options.method === 'bank_card' ? 'fixture-bank' : null}, ${status},
      ${`W${randomBytes(12).toString('hex')}`}, ${options.method},
      ${options.paid ? options.adminId : null}, ${options.paid ? reviewedAt : null},
      ${options.paid ? options.adminId : null}, ${options.paid ? reviewedAt : null}, ${paidAt},
      ${createdAt}, ${paidAt ?? createdAt})`.execute(db);
  return {
    withdrawal_id: id,
    status,
    amount_fen: 10000n,
    fee_fen: 100n,
    tax_fen: 0n,
    net_fen: 9900n,
    payout_channel: options.method,
    created_at: createdAt,
    paid_at: paidAt,
  };
}

/**
 * An Agent session (of the user, or a guest's when `owner` is null) with one turn: the user's
 * message and the assistant's answer, which the console handled as a report (handler, note).
 */
async function agentSession(
  db: Kysely<DB>,
  appId: string,
  owner: Person | null,
  deviceId: string,
  options: {
    readonly lastActiveMs: number;
    readonly expired: boolean;
    readonly adminId: string;
    readonly reportNote: string;
  },
): Promise<PersonalDataCopyAgentConversation> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const lastActiveAt = at(options.lastActiveMs);
  const startedAt = at(options.lastActiveMs - 30 * MINUTE_MS);
  const askedAt = at(options.lastActiveMs - 20 * MINUTE_MS);
  const answeredAt = at(options.lastActiveMs - 19 * MINUTE_MS);
  const question = `user-asks-${randomUUID()}`;
  const answer = `assistant-answers-${randomUUID()}`;
  await sql`INSERT INTO app.agent_sessions (id, app_id, user_id, device_id, started_at,
      last_active_at, expired_at, created_at, updated_at)
    VALUES (${sessionId}, ${appId}, ${owner?.uid ?? null}, ${deviceId}, ${startedAt},
      ${lastActiveAt}, ${options.expired ? at(options.lastActiveMs + MINUTE_MS) : null},
      ${startedAt}, ${lastActiveAt})`.execute(db);
  await sql`INSERT INTO app.agent_runs (id, app_id, session_id, user_text, prompt_version,
      accepted_at, quota_subjects, created_at, updated_at)
    VALUES (${runId}, ${appId}, ${sessionId}, ${question}, 'fixture-v1', ${askedAt},
      ${['user']}::text[], ${askedAt}, ${askedAt})`.execute(db);
  await sql`INSERT INTO app.agent_messages (id, app_id, session_id, run_id, client_msg_id, role,
      text, created_at, updated_at)
    VALUES (${randomUUID()}, ${appId}, ${sessionId}, ${runId}, ${`m-${randomUUID()}`}, 'user',
      ${question}, ${askedAt}, ${askedAt})`.execute(db);
  await sql`INSERT INTO app.agent_messages (id, app_id, session_id, run_id, role, text, reported,
      report_reason, reported_at, report_status, report_handler_id, report_handled_at,
      report_note, created_at, updated_at)
    VALUES (${randomUUID()}, ${appId}, ${sessionId}, ${runId}, 'assistant', ${answer}, true,
      'harmful', ${answeredAt}, 'handled', ${options.adminId}, ${lastActiveAt},
      ${options.reportNote}, ${answeredAt}, ${lastActiveAt})`.execute(db);
  return {
    session_id: sessionId,
    started_at: startedAt,
    last_active_at: lastActiveAt,
    messages: [
      { role: 'user', text: question, created_at: askedAt },
      { role: 'assistant', text: answer, created_at: answeredAt },
    ],
  };
}

/** One app with A (the subject), P (A's inviter), C (A's invitee), O (another member), N (bare). */
export async function world(db: Kysely<DB>, crypto: FieldCrypto) {
  const appId = `pdc_${randomBytes(10).toString('hex')}`;
  const adminId = randomUUID();
  const reportNote = `handled-note-${randomUUID()}`;
  await admin(db, appId, adminId);
  const inviter = await person(db, crypto, appId, {
    nickname: '邀请人甲',
    phone: '13800138009',
    parentId: null,
    createdAt: at(-300 * DAY_MS),
  });
  const a = await person(db, crypto, appId, {
    nickname: NICKNAME,
    phone: PHONE,
    parentId: inviter.uid,
    createdAt: at(REGISTERED_AT_MS),
  });
  const invitee = await person(db, crypto, appId, {
    nickname: '下级乙',
    phone: '13800138002',
    parentId: a.uid,
    createdAt: at(-10 * DAY_MS),
  });
  const other = await person(db, crypto, appId, {
    nickname: '旁人丙',
    phone: '13800138001',
    parentId: inviter.uid,
    createdAt: at(-50 * DAY_MS),
  });
  const bare = await person(db, crypto, appId, {
    nickname: '无号丁',
    phone: null,
    parentId: null,
    createdAt: at(-5 * DAY_MS),
  });

  await oauth(db, a, 'wechat');
  await oauth(db, a, 'apple');
  await oauth(db, other, 'wechat');

  await realname(db, crypto, a, REAL_NAME, ID_NO, BIRTH_DATE);
  await realname(db, crypto, other, '李四五', '110101198805051234', '1988-05-05');

  const aDevice = await device(db, appId);
  const otherDevice = await device(db, appId);
  const consents = [
    await userConsent(db, a, {
      type: 'privacy',
      version: 3,
      channel: 'login_page',
      accepted: true,
      client_at: at(REGISTERED_AT_MS),
    }),
    await userConsent(db, a, {
      type: 'ai_third_party',
      version: 1,
      channel: 'agent_sheet',
      accepted: false,
      client_at: at(-40 * DAY_MS),
    }),
  ];
  await userConsent(db, other, {
    type: 'agreement',
    version: 2,
    channel: 'login_page',
    accepted: true,
    client_at: at(-50 * DAY_MS),
  });
  await deviceConsent(db, appId, aDevice);

  const orders = [
    await order(db, a, { title: 'Visible Headphones', payFen: 12345, ageMs: 3 * DAY_MS }),
    await order(db, a, { title: 'Old Kettle', payFen: 2990, ageMs: 400 * DAY_MS }),
  ];
  const otherOrder = await order(db, other, {
    title: `Other Person Order ${randomUUID()}`,
    payFen: 777,
    ageMs: 2 * DAY_MS,
  });

  await credit(db, a, CREDIT_FEN);
  // O's credit: its counter-entry (+5678) is what the ledger section of A must not carry either.
  await credit(db, other, -5678n);

  const withdrawals = [
    {
      ...(await withdrawal(db, crypto, a, {
        method: 'alipay',
        account: ALIPAY,
        payeeName: PAYEE_NAME,
        paid: false,
        adminId,
        ageMs: DAY_MS,
      })),
      masked_account: MASKED_ALIPAY,
    },
    {
      ...(await withdrawal(db, crypto, a, {
        method: 'bank_card',
        account: CARD_NO,
        payeeName: PAYEE_NAME,
        paid: true,
        adminId,
        ageMs: 30 * DAY_MS,
      })),
      masked_account: MASKED_CARD,
    },
  ];
  const otherWithdrawal = await withdrawal(db, crypto, other, {
    method: 'alipay',
    account: 'lisi@example.com',
    payeeName: '李四五',
    paid: false,
    adminId,
    ageMs: DAY_MS,
  });

  const report = { adminId, reportNote };
  // Idle for 3 days and ended (BR-AI-20 expired) but well within the 190-day retention.
  const liveConversation = await agentSession(db, appId, a, aDevice, {
    lastActiveMs: -3 * DAY_MS,
    expired: true,
    ...report,
  });
  // Past the retention of BR-ID-30 ① (190 days) whatever the anchor.
  const oldConversation = await agentSession(db, appId, a, aDevice, {
    lastActiveMs: -400 * DAY_MS,
    expired: true,
    ...report,
  });
  const guestConversation = await agentSession(db, appId, null, aDevice, {
    lastActiveMs: -2 * DAY_MS,
    expired: false,
    ...report,
  });
  const otherConversation = await agentSession(db, appId, other, otherDevice, {
    lastActiveMs: -DAY_MS,
    expired: false,
    ...report,
  });

  return {
    appId,
    adminId,
    reportNote,
    inviter,
    a,
    invitee,
    other,
    bare,
    consents,
    orders,
    otherOrder,
    withdrawals,
    otherWithdrawal,
    liveConversation,
    oldConversation,
    guestConversation,
    otherConversation,
  };
}
export type World = Awaited<ReturnType<typeof world>>;
