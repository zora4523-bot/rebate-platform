// B1-12u rule-test kit (BR-TEXT-09, BR-TEXT-08, BR-WDR-26; D10-228, D10-235, D10-260). Expected
// texts are written out by hand from the task brief (§9.1) and 08 at SPEC_REF, never read from the
// implementation. Only *.int.test.ts imports the test database factory and passes it in here.
// Every payee value is synthetic and low-entropy.
import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import type { PushDeliveryChannel } from '../../../../apps/api/src/modules/notification/ports/push-delivery.ts';
import { createWithdrawalResultMessageConsumer } from '../../../../apps/api/src/modules/notification/application/withdrawal-result-message.ts';

export const NOW = '2026-10-31T09:08:07.006Z';
export const CONSUMER = 'notification-withdrawal-result';
export const QUEUE = 'evt.notification-withdrawal-result';
export const EVENT = 'wallet.withdrawal_changed';

/** Low-entropy synthetic payee material (task brief §9.3). */
export const PLAIN = 'plain-plain-plain-plain';

/** inbox.title.<code> (BR-TEXT-09 细则标题表; contracts/texts.default.json). */
export const TITLES = {
  WD_SUCCESS: '提现到账',
  WD_REJECTED: '提现未通过',
  WD_FAILED: '提现打款未成功',
} as const;

/** BR-TEXT-08 驳回原因表 (dictionary withdraw_reject_reason), verbatim. */
export const REJECT_REASONS = {
  RISK_SUSPECT: '账户存在异常，需要核实，请联系客服',
  ORDER_ABNORMAL: '部分订单状态待核实，请稍后重新申请',
  PAYEE_INFO_INVALID: '收款信息有误，请核对后重新申请',
  USER_REQUEST: '已按你的要求取消本次提现',
  OTHER: '其他原因，请联系客服',
  NEGATIVE_BALANCE: '有订单被扣回，冻结金额已用于抵扣',
} as const;

/** BR-TEXT-08 失败原因映射: every mapped code has「修改收款账号」= 显示 (account type). */
export const FAIL_REASONS = {
  PAYEE_NOT_EXIST: '收款支付宝账号不存在',
  PAYEE_USER_INFO_ERROR: '收款账号姓名与实名信息不一致',
  PAYEE_ACCOUNT_STATUS_ERROR: '收款支付宝账号状态异常',
} as const;

/** BR-TEXT-08 细则 (D10-228): the fallback used as {reason}, without an amount. */
export const FAIL_FALLBACK = '收款渠道未能完成这笔转账';

/** BR-TEXT-09 (account-type fail codes): appended at the end of the WD_FAILED sentence. */
export const CHANGE_ACCOUNT = '，可修改收款账号后重试';

/** {payout_channel_name}: the same field as the withdrawal detail (BR-TEXT-06). */
export const CHANNEL_NAMES = {
  alipay: '支付宝',
  bank_card: '银行卡',
  wechat: '微信零钱',
} as const;

export type Channel = keyof typeof CHANNEL_NAMES;
export type WithdrawalRow = Selectable<DB['withdrawals']>;

// Structural type instead of importing @couli/db/testing (int tests only).
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  return {
    db,
    async close() {
      try {
        await destroyDb(db);
      } finally {
        await database.drop();
      }
    },
  };
}
export type Suite = Awaited<ReturnType<typeof openSuite>>;

export async function seedUser(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'sms',
    })
    .execute();
  return id;
}

/** Columns a stored withdrawal of `status` needs (paid_at, manual entry, reason codes). */
function statusColumns(status: string): Partial<Insertable<DB['withdrawals']>> {
  switch (status) {
    case 'PAID_API':
      return { paid_at: new Date('2026-10-30T01:02:03.000Z') };
    case 'PAID_MANUAL':
      return {
        paid_at: new Date('2026-10-30T01:02:03.000Z'),
        manual_entry_by: randomUUID(),
        manual_confirm_by: randomUUID(),
      };
    case 'REJECTED':
      return { reject_reason_code: 'RISK_SUSPECT', reject_note: '仅内部可见的合成备注' };
    case 'FAILED':
      return { fail_code: 'PAYEE_NOT_EXIST' };
    default:
      return {};
  }
}

export async function seedWithdrawal(
  db: Kysely<DB>,
  owner: { appId: string; userId: string },
  patch: Partial<Insertable<DB['withdrawals']>> & { payout_channel?: Channel } = {},
): Promise<WithdrawalRow> {
  const channel: Channel = patch.payout_channel ?? 'alipay';
  const status = patch.status ?? 'PAID_API';
  const amount = patch.amount_fen ?? 1000n;
  const fee = patch.fee_fen ?? 0n;
  const tax = patch.tax_fen ?? 80n;
  return db
    .insertInto('withdrawals')
    .values({
      id: randomUUID(),
      app_id: owner.appId,
      user_id: owner.userId,
      amount_fen: amount,
      fee_fen: fee,
      tax_fen: tax,
      net_fen: amount - fee - tax,
      income_type: 'SERVICE_FEE',
      payout_method: channel,
      payout_channel: channel,
      payee_name: '合成收款人',
      payee_account_cipher: Buffer.from(PLAIN),
      payee_hmac: PLAIN,
      bank_name: channel === 'bank_card' ? '合成测试银行' : null,
      wechat_app_id: channel === 'wechat' ? 'wx-plain-plain' : null,
      status,
      out_biz_no: randomUUID().replace(/-/g, ''),
      created_at: new Date('2026-10-29T01:02:03.456Z'),
      updated_at: new Date('2026-10-29T01:02:03.456Z'),
      ...statusColumns(status),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function eventOf(
  appId: string,
  data: { withdrawal_id: string; user_id: string; status: string },
  attempt = 1,
): ReceivedEvent {
  return {
    eventId: randomUUID(),
    appId,
    name: EVENT,
    version: 1,
    occurredAt: '2026-10-31T09:00:00.000Z',
    consumer: CONSUMER,
    attempt,
    payload: { ...data },
  };
}

/** The queue job of an event, as the bus enqueues it (envelope app_id, v, occurred_at, data). */
export function job(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}

export async function fixture(suite: Suite, appId = `wd-message-${randomUUID()}`) {
  const db = suite.db;
  const userId = await seedUser(db, appId);
  const clock = new FixedClock(NOW);
  const channel = {
    send: vi.fn<PushDeliveryChannel['send']>().mockResolvedValue({ status: 'accepted' }),
  };
  // Every bound session is valid: the pre-send check is B1-12o's, not this task's.
  const sessionValidity = vi.fn(
    async (_executor: unknown, query: { readonly sids: readonly string[] }) =>
      new Set<string>(query.sids),
  );
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  // SUT construction belongs in each test body (through these helpers), so the skeleton's
  // NotImplemented is an individual red result.
  function consumer() {
    return createWithdrawalResultMessageConsumer({
      clock,
      logger,
      push: createPushSendCore({ clock, channel, sessionValidity }),
    });
  }
  return {
    db,
    appId,
    userId,
    clock,
    channel,
    lines,
    consumer,
    withdrawal(
      patch: Partial<Insertable<DB['withdrawals']>> & { payout_channel?: Channel } = {},
      owner: { appId: string; userId: string } = { appId, userId },
    ) {
      return seedWithdrawal(db, owner, patch);
    },
    event(row: { id: string; user_id: string }, status: string, attempt = 1) {
      return eventOf(appId, { withdrawal_id: row.id, user_id: row.user_id, status }, attempt);
    },
    /** The production sequence: handle() in the event transaction, then dispatch() after it. */
    async deliver(event: ReceivedEvent) {
      const sut = consumer();
      await db.transaction().execute((trx) => sut.handle(event, trx));
      await sut.dispatch(db, event);
    },
    /** handle() only, on `connection`'s transaction (a fault plugin, or a caller's transaction). */
    async handle(event: ReceivedEvent, connection: Kysely<DB> = db) {
      const sut = consumer();
      await connection.transaction().execute((trx) => sut.handle(event, trx));
    },
    /** A live push registration of the recipient, bound to a session the fake reports valid. */
    async token(owner: { appId: string; userId: string } = { appId, userId }) {
      const id = randomUUID();
      const deviceId = randomUUID();
      await db
        .insertInto('devices')
        .values({
          id: deviceId,
          app_id: owner.appId,
          device_hash: createHash('sha256').update(deviceId).digest('hex'),
          id_source: 'idfv',
          platform: 'ios',
          app_version: '1.0.0',
          install_secret_cipher: Buffer.from(PLAIN),
          last_seen_at: new Date(NOW),
        })
        .execute();
      await db
        .insertInto('push_tokens')
        .values({
          id,
          app_id: owner.appId,
          user_id: owner.userId,
          device_id: deviceId,
          bound_sid: `session-${id}`,
          provider: 'mobpush',
          token: `device-reg-${id}`,
          token_set_at: new Date(NOW),
          frozen_until: null,
          revoked_at: null,
        })
        .execute();
      return { provider: 'mobpush', token: `device-reg-${id}` };
    },
    async settings(
      values: { service_push: boolean; subscription_push: boolean; marketing_push: boolean },
      owner: { appId: string; userId: string } = { appId, userId },
    ) {
      await db
        .insertInto('notification_settings')
        .values({ app_id: owner.appId, user_id: owner.userId, ...values })
        .execute();
    },
    async template(
      code: keyof typeof TITLES,
      variant: string,
      overrides: Partial<Insertable<DB['notify_templates']>> = {},
    ) {
      await db
        .insertInto('notify_templates')
        .values({
          app_id: appId,
          code,
          variant,
          category: 'service',
          channels: ['inbox', 'push'],
          route: null,
          title_override: null,
          body_override: null,
          ...overrides,
        })
        .execute();
    },
    async rows(app = appId) {
      return {
        inbox: await db
          .selectFrom('inbox_messages')
          .selectAll()
          .where('app_id', '=', app)
          .orderBy('created_at')
          .orderBy('message_id')
          .execute(),
        logs: await db
          .selectFrom('notify_logs')
          .selectAll()
          .where('app_id', '=', app)
          .orderBy('dedupe_key')
          .execute(),
      };
    },
    /** Log lines at warn (pino level 40) that mention `text`. */
    warnings(text: string) {
      return lines.filter((line) => line.level === 40 && JSON.stringify(line).includes(text));
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
