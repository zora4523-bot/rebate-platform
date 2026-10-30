// Database fixtures of the B1-03z rule tests: synthetic rows only (users, order_keys, the split
// snapshot of commission, its share events, appeals). No implementation code computes an expected
// value. Each test makes its own app_id, so tests sharing one database never see each other.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
// By file path, not commission/index.ts: the index reaches identity's decorated controllers.
import { listBannedForfeitedShares } from '../../../../apps/api/src/modules/commission/application/forfeited-shares.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';
import { createAppealRestoreHandler } from '../../../../apps/api/src/modules/risk/application/appeal-restore.ts';
import {
  APPEAL_AT,
  CLOSED_AT,
  DEADLINE_AT,
  NOW,
  ORDER_AT,
  PENALTY_AT,
  PERIOD,
  RESTORE_SOURCES,
  resolvedEvent,
  type AppealResolvedData,
  type ShareRole,
} from './kit.ts';

// Structural type instead of importing @couli/db/testing: only *.int.test.ts may import it
// (.dependency-cruiser.cjs testcontainers-only-in-int-tests); the int test passes its factory.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
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

export interface SharePerson {
  readonly userId: string;
  readonly role: ShareRole;
  /** commission_split_amounts.amount_fen of the only commission version (1). */
  readonly amountFen: bigint;
}

export interface AppealInput {
  readonly userId: string | null;
  readonly targetType?: 'account' | 'order' | 'blocked_request';
  readonly status?: 'revoked' | 'upheld';
  readonly prev?: 'banned' | 'frozen';
  /** Account appeals only; null: a row from before the column (B1-03v). */
  readonly penaltyStartedAt?: Date | null;
  readonly requestType?: 'register' | 'withdraw';
  readonly targetId?: string;
}

export interface Appeal {
  readonly id: string;
  readonly data: AppealResolvedData;
}

/** The restore difference expected for one share of one appeal (task brief 9.2 ④). */
export interface ExpectedRestore {
  readonly appealId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: ShareRole;
  readonly amountFen: bigint;
}

const N_FEN = 1000n;
const BASE_FEN = 850n;

export async function scenario(suite: Suite) {
  const db = suite.db;
  const appId = `appeal-restore-${randomUUID()}`;
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: ORDER_AT,
      indirect_enabled: true,
      created_at: ORDER_AT,
    })
    .execute();
  const clock = new FixedClock(NOW);

  async function user(): Promise<string> {
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

  /** One sub-order with its split snapshot (version 1) and an initial active event per person. */
  async function order(people: readonly SharePerson[]): Promise<string> {
    const orderId = randomUUID();
    await db
      .insertInto('order_keys')
      .values({
        app_id: appId,
        order_id: orderId,
        platform: 'taobao',
        sub_order_id: `appeal-restore-${orderId}`,
        attr_at: ORDER_AT,
      })
      .execute();
    const userTotal = people.reduce((sum, p) => sum + p.amountFen, 0n);
    await db
      .insertInto('commission_splits')
      .values({
        app_id: appId,
        order_id: orderId,
        rule_version_id: ruleVersionId,
        order_type: people.some((p) => p.role === 'share') ? 'share' : 'self',
        activity_type: null,
        rebate_mode: null,
        paid_at: ORDER_AT,
        paid_at_source: 'platform',
        raw_n_fen: N_FEN,
        subsidy_commission_fen: 0n,
        reserve_bp: 1500,
        reserve_fen: N_FEN - BASE_FEN,
        tlj_deduct_fen: 0n,
        base_fen: BASE_FEN,
        platform_retain_fen: BASE_FEN - userTotal,
        beneficiaries: JSON.stringify(
          people.map((p) => ({
            user_id: p.userId,
            role: p.role,
            ratio_bp: 1000,
            level: 'L1',
            initial_status: 'active',
            forfeit_reason: null,
          })),
        ),
        created_at: ORDER_AT,
      })
      .execute();
    await db
      .insertInto('commission_split_totals')
      .values({
        app_id: appId,
        order_id: orderId,
        commission_version: 1,
        n_total_fen: N_FEN,
        pre_base_deduct_fen: N_FEN - BASE_FEN,
        base_fen: BASE_FEN,
        user_share_total_fen: userTotal,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: N_FEN - userTotal,
        created_at: ORDER_AT,
      })
      .execute();
    await db
      .insertInto('commission_split_amounts')
      .values(
        people.map((p) => ({
          app_id: appId,
          order_id: orderId,
          commission_version: 1,
          user_id: p.userId,
          role: p.role,
          base_fen: BASE_FEN,
          amount_fen: p.amountFen,
          created_at: ORDER_AT,
        })),
      )
      .execute();
    for (const p of people) {
      await shareEvent(orderId, p.userId, p.role, 'active', null, ORDER_AT);
    }
    return orderId;
  }

  async function shareEvent(
    orderId: string,
    userId: string,
    role: ShareRole,
    status: 'active' | 'held' | 'forfeited',
    reason: 'banned' | 'deleted' | 'minor' | null,
    at: Date,
  ): Promise<void> {
    await db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: appId,
        order_id: orderId,
        user_id: userId,
        role,
        status,
        reason,
        created_at: at,
      })
      .execute();
  }

  /** A forfeited event of one share (BR-CALC-13 forfeit_reason). */
  async function forfeit(
    orderId: string,
    p: Pick<SharePerson, 'userId' | 'role'>,
    reason: 'banned' | 'deleted' | 'minor',
    at: Date,
  ): Promise<void> {
    await shareEvent(orderId, p.userId, p.role, 'forfeited', reason, at);
  }

  /** A closed appeal row (risk's appeals) and the appeal.resolved data of its closing. */
  async function appeal(input: AppealInput): Promise<Appeal> {
    const id = randomUUID();
    const targetType = input.targetType ?? 'account';
    const status = input.status ?? 'revoked';
    const account = targetType === 'account';
    const requestType = targetType === 'blocked_request' ? (input.requestType ?? 'withdraw') : null;
    const targetId =
      input.targetId ?? (account && input.userId !== null ? input.userId : randomUUID());
    await db
      .insertInto('appeals')
      .values({
        id,
        app_id: appId,
        user_id: input.userId,
        target_type: targetType,
        request_type: requestType,
        target_id: targetId,
        // Low-entropy placeholder: never a real HMAC.
        related_phone_hmac: requestType === 'register' ? 'plain-plain-plain-plain' : null,
        prev_risk_state: account ? (input.prev ?? 'banned') : null,
        status,
        content: 'fixture appeal content',
        deadline_at: DEADLINE_AT,
        handler_id: 'fixture-admin',
        closed_at: CLOSED_AT,
        created_at: APPEAL_AT,
        updated_at: CLOSED_AT,
        penalty_started_at: account
          ? input.penaltyStartedAt === undefined
            ? PENALTY_AT
            : input.penaltyStartedAt
          : null,
      })
      .execute();
    return {
      id,
      data: {
        app_id: appId,
        appeal_id: id,
        user_id: input.userId,
        target_type: targetType,
        target_id: targetId,
        status,
        need_reauth: false,
      },
    };
  }

  return {
    db,
    appId,
    clock,
    user,
    order,
    shareEvent,
    forfeit,
    appeal,
    event(a: Appeal, eventId?: string): ReceivedEvent {
      const received = resolvedEvent(a.data);
      return eventId === undefined ? received : { ...received, eventId };
    },
    /**
     * The SUT, created in the test body so that every case fails on the skeleton. commission's
     * shares port is injected as the worker assembly does (RiskScanModule.forWorker).
     */
    handler() {
      return createAppealRestoreHandler({ clock, shares: listBannedForfeitedShares });
    },
    /** Delivers one event directly to a new handler on one transaction of the suite. */
    async deliver(received: ReceivedEvent): Promise<void> {
      const handle = createAppealRestoreHandler({ clock, shares: listBannedForfeitedShares });
      await db.transaction().execute((trx) => handle(received, trx));
    },
    /** recon_diffs of this app, smallest expected amount first. */
    async diffs(handle: Kysely<DB> = db) {
      return handle
        .selectFrom('recon_diffs')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('expected_fen')
        .orderBy('id')
        .execute();
    },
    /** Everything the producer must never write: ledger, share events, obligations, appeals. */
    async untouched() {
      return {
        accounts: await db
          .selectFrom('ledger_accounts')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        balances: await db
          .selectFrom('account_balances')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('account_id')
          .execute(),
        vouchers: await db
          .selectFrom('ledger_vouchers')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        entries: await db
          .selectFrom('ledger_entries')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        events: await db
          .selectFrom('commission_split_beneficiary_events')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('event_seq')
          .execute(),
        credits: await db
          .selectFrom('beneficiary_credits')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('beneficiary_credit_id')
          .execute(),
        appeals: await db
          .selectFrom('appeals')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
      };
    },
  };
}
export type Scenario = Awaited<ReturnType<typeof scenario>>;

type DiffRow = Awaited<ReturnType<Scenario['diffs']>>[number];

/**
 * One appeal_restore row of a share (task brief 9.2 ④; contracts AdminReconDiff: diff_fen =
 * expected_fen − actual_fen): registered open, ref to the sub-order, expected the share's amount,
 * actual 0, dedupe key naming app, order, user, role and appeal. Source and period are the
 * implementation's (written down there): only their allowed shapes are checked.
 */
export function expectRestore(row: DiffRow | undefined, appId: string, share: ExpectedRestore) {
  expect(row).toMatchObject({
    app_id: appId,
    type: 'appeal_restore',
    ref_type: 'order',
    expected_fen: share.amountFen,
    actual_fen: 0n,
    diff_fen: share.amountFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
  });
  expect(row?.ref_id).toContain(share.orderId);
  expect(RESTORE_SOURCES).toContain(row?.source);
  expect(row?.period).toMatch(PERIOD);
  const key = row?.dedupe_key;
  expect(typeof key).toBe('string');
  for (const part of [appId, share.orderId, share.userId, share.role, share.appealId]) {
    expect(key).toContain(part);
  }
}

/** Real database error on an insert into `table`, with no DDL or privileged connection. */
export function failInsert(table: 'recon_diffs') {
  let fired = false;
  // Kysely forbids a plugin from changing the node kind, so the matching insert runs and its
  // result is replaced by PostgreSQL's division-by-zero error (22012): the caller's transaction
  // still fails and rolls back.
  const matched = new Set<unknown>();
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      const statement = new PostgresQueryCompiler().compileQuery(args.node, args.queryId).sql;
      if (new RegExp(`\\binsert\\s+into\\s+(?:"?app"?\\.)?"?${table}"?\\b`, 'i').test(statement)) {
        matched.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (matched.delete(args.queryId)) {
        fired = true;
        throw Object.assign(new Error('division by zero'), { code: '22012' });
      }
      return args.result;
    },
  };
  return { fired: () => fired, plugin };
}
