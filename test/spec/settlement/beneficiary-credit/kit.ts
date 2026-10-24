// Shared harness of the B2-04q rule tests: execution of one beneficiary credit item (R5a,
// BR-FUND-04 ⑫). Synthetic rows only. Every order is seeded already CREDITED, with the vouchers an
// R5 credit (and optionally a later BR-FUND-09 positive diff) would have left, so that BR-FUND-19 ⑤
// holds before the item runs; expected amounts are written by hand in the tests (the seeding derives
// its own vouchers from the BR-CALC-02 / BR-CALC-04 formulas), never by calling the planner.
//
// Default order: N = 1000, reserve_bp 1500 → booked_base_fen 850, reserve 150; self 5000 / direct
// 1000 / indirect 500 → 425 / 85 / 42; platform 298 + 150 = 448. Direct was held at R5 (first_credit
// obligation open), so UNION_RECEIVABLE = 1000 − 85 = 915.
// With adjustTo = 1200 (seq 2): booked_base_fen 1020, reserve 180 → 510 / 102 / 51; platform 357 +
// 180 = 537 (+89); a deferred direct keeps its 85 and is owed 17, UNION_RECEIVABLE = 1183.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { addFen, mulDivFloor, subFen } from '@couli/money';
import {
  PostgresQueryCompiler,
  sql,
  type Insertable,
  type Kysely,
  type QueryId,
  type Transaction,
} from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import {
  createLedger,
  getOrderNets,
  type Ledger,
  type OrderNets,
  type PostingEntry,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createBeneficiaryCredit,
  type BeneficiaryCredit,
  type BeneficiaryCreditDependencies,
  type BeneficiaryCreditInput,
  type BeneficiaryCreditResult,
} from '../../../../apps/api/src/modules/settlement/credit/beneficiary/index.ts';
import {
  createBeneficiaryGate,
  type BeneficiaryGate,
  type BeneficiaryGateOptions,
  type CreditRole,
  type MinorStatusReader,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';

// Exercise identity/index.ts at runtime; the URL import keeps Nest decorators out of the test TS
// project (same as the B2-04m rule tests). The type queries are erased.
const { createRealnameStatusBatchReader, createUserDeletionStatusReader, lockUsersForUpdate } =
  (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as typeof import('../../../../apps/api/src/modules/identity/ports/realname-status-batch.ts') &
    typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts') &
    typeof import('../../../../apps/api/src/modules/identity/ports/lock-users.ts');

// Through commission's public entry, loaded at run time like the other settlement rule tests do.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as { readCommissionSnapshot: BeneficiaryCreditDependencies['readSnapshot'] };

export const NOW = '2032-08-24T10:00:00+08:00';
export const CREDITED_AT = '2032-07-24T10:00:00+08:00';
export const BEFORE = '2032-06-20T10:00:00+08:00';
export const PERIOD = '2032-06';
export const TIMEOUT = 120_000;
export const ALERT = 'beneficiary_credit_invariant_mismatch';

interface TestDatabaseLike {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export interface Pools {
  readonly db: Kysely<DB>;
  readonly left: Kysely<DB>;
  readonly right: Kysely<DB>;
  readonly control: Kysely<DB>;
}

/** One test database per file; `db` seeds and reads, left / right / control are single connections. */
export function databaseFixture(create: () => Promise<TestDatabaseLike>): Pools {
  let database: TestDatabaseLike | undefined;
  let pools: Pools | undefined;
  beforeAll(async () => {
    database = await create();
    const connectionString = database.urlFor('couli_app');
    pools = {
      db: createDb({ connectionString, max: 6 }),
      left: createDb({ connectionString, max: 1 }),
      right: createDb({ connectionString, max: 1 }),
      control: createDb({ connectionString, max: 1 }),
    };
  }, TIMEOUT);
  afterAll(async () => {
    try {
      const open: Kysely<DB>[] =
        pools === undefined ? [] : [pools.db, pools.left, pools.right, pools.control];
      await Promise.all(open.map(destroyDb));
    } finally {
      await database?.drop();
    }
  }, TIMEOUT);
  const get = (): Pools => {
    if (pools === undefined) throw new Error('beneficiary-credit pools are not open');
    return pools;
  };
  return {
    get db() {
      return get().db;
    },
    get left() {
      return get().left;
    },
    get right() {
      return get().right;
    },
    get control() {
      return get().control;
    },
  };
}

export type UserState =
  | 'normal'
  | 'frozen'
  | 'appealing'
  | 'banned'
  | 'deleting'
  | 'deleted'
  | 'minor'
  | 'adult'
  /** Open deletion request in its cooling-off window; users.status stays normal (BR-ID-28). */
  | 'cooling';

export interface PersonSpec {
  readonly role: CreditRole;
  readonly ratioBp: number;
  /** The beneficiary's state now (at execution), not at R5. */
  readonly state?: UserState;
}

/** The opening transaction of a deferred obligation and the voucher type it fixes (04, 0066). */
export interface DeferredOrigin {
  readonly openedBy: 'R10' | 'R13';
  readonly ledgerType: 'SETTLE_ADJUST' | 'ADMIN_ADJUST';
  readonly subType: 'SETTLE_DIFF' | 'PRICE_COMPARE' | 'PRICE_PROTECT' | 'RESTORE';
}

export const SETTLE_DIFF: DeferredOrigin = {
  openedBy: 'R10',
  ledgerType: 'SETTLE_ADJUST',
  subType: 'SETTLE_DIFF',
};

export interface OrderSpec {
  readonly people?: readonly PersonSpec[];
  /** N of the R5 credit (orders.settle_commission_fen, order_settlements seq 1). */
  readonly settleFen?: bigint;
  readonly reserveBp?: number;
  /**
   * Roles held at R5: no CREDIT voucher, a held event and an open first_credit obligation.
   * Default ['direct'] when `deferred` is not given, else none.
   */
  readonly held?: readonly CreditRole[];
  /**
   * A later N (order_settlements seq 2, BR-FUND-09 positive diff, ≥ settleFen): every credited role
   * that is not deferred gets its diff as `ADJ:2`, the platform its diff as `PLATFORM:ADJ:2`.
   */
  readonly adjustTo?: bigint;
  /** Roles whose positive diff was deferred at seq 2: one open deferred obligation each. */
  readonly deferred?: readonly CreditRole[];
  readonly origin?: DeferredOrigin;
  readonly platform?: string;
  readonly subOrderId?: string;
  readonly patch?: Partial<Insertable<DB['orders']>>;
  /** Overrides of every seeded obligation row (status, split_ref, closing fields). */
  readonly obligationPatch?: Partial<Insertable<DB['beneficiary_credits']>>;
  /** order_settlements seqs that arrived after the batch item was generated. */
  readonly laterSeqs?: readonly number[];
}

export interface SeededPerson {
  readonly userId: string;
  readonly role: CreditRole;
  readonly ratioBp: number;
}

export interface SeededObligation {
  readonly beneficiaryCreditId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly kind: 'first_credit' | 'deferred';
}

export interface SeededOrder {
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly orderKey: string;
  readonly attrAt: Date;
  /** order_settlements seq when the batch item was generated (BR-FUND-04 ⑫). */
  readonly itemSeq: number;
  readonly bookedBaseFen: bigint;
  readonly bookedNFen: bigint;
  readonly people: readonly SeededPerson[];
  readonly obligations: readonly SeededObligation[];
  /** Beneficiary events written by the seeding (initial active ones plus R5 held ones). */
  readonly seededEvents: number;
  user(role: CreditRole): string;
  /** The obligation of `role`, or the only obligation when `role` is omitted. */
  obligation(role?: CreditRole): SeededObligation;
}

export const DEFAULT_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
];

export interface ExecuteOptions {
  /** Executor of the item transaction (another pool, a traced or a faulty one). */
  readonly via?: Kysely<DB>;
  /** The obligation to execute (default: the order's only obligation). */
  readonly role?: CreditRole;
  readonly input?: Partial<BeneficiaryCreditInput>;
  /** Called with the backend pid before the item starts (lock / statement timeouts set). */
  readonly onPid?: (pid: number) => void;
}

export interface Line {
  readonly uniq_key: string;
  readonly subject: string;
  readonly owner_id: string;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Bounded waits inside a test transaction; returns its backend pid. */
export async function bounded(trx: Transaction<DB>): Promise<number> {
  await sql`SET LOCAL statement_timeout = '20s'`.execute(trx);
  await sql`SET LOCAL lock_timeout = '15s'`.execute(trx);
  const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.pid;
}

/** Observe a real server-side lock wait (pg_blocking_pids), never infer it from a sleep. */
export async function waitBlocked(db: Kysely<DB>, waiter: number, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = await sql<{ blocked: boolean }>`
      SELECT ${holder} = ANY(pg_blocking_pids(${waiter})) AS blocked`.execute(db);
    if (result.rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backend ${waiter} did not wait for ${holder}`);
}

export interface CompiledQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Records every statement (builder and raw) run through the returned executor. */
export function tracing(db: Kysely<DB>) {
  const queries: CompiledQuery[] = [];
  const traced = db.withPlugin({
    transformQuery(args) {
      queries.push(new PostgresQueryCompiler().compileQuery(args.node, args.queryId));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: traced, queries };
}

/**
 * Fails a matching statement after PostgreSQL has executed it (builder and raw statements alike),
 * so the database really holds the write when the error reaches the service.
 */
export function failAfter(db: Kysely<DB>, match: (query: CompiledQuery) => boolean) {
  const pending = new Set<QueryId>();
  let injected = 0;
  const faulty = db.withPlugin({
    transformQuery(args) {
      if (match(new PostgresQueryCompiler().compileQuery(args.node, args.queryId))) {
        pending.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        injected += 1;
        throw new Error('injected failure after the statement ran');
      }
      return args.result;
    },
  });
  return { db: faulty, injected: () => injected };
}

/** floor(B × ratio / 10000), the BR-CALC-04 share. */
export function shareOf(base: bigint, ratioBp: number): bigint {
  return mulDivFloor(base, BigInt(ratioBp), 10000n);
}

/** BR-CALC-02 (tlj 0): B = floor(max(0,N) × (10000 − reserve_bp) / 10000), reserve = max(0,N) − B. */
export function baseOf(n: bigint, reserveBp: number): { base: bigint; reserve: bigint } {
  const positive = n > 0n ? n : 0n;
  const base = mulDivFloor(positive, BigInt(10000 - reserveBp), 10000n);
  return { base, reserve: subFen(positive, base) };
}

/** BR-FUND-05 entry types of a beneficiary CREDIT per role. */
export const CREDIT_TYPES: Readonly<Record<CreditRole, { type: string; sub: string | null }>> = {
  self: { type: 'REBATE_CREDIT', sub: null },
  share: { type: 'SHARE_CREDIT', sub: null },
  direct: { type: 'REFERRAL_CREDIT', sub: 'DIRECT' },
  indirect: { type: 'REFERRAL_CREDIT', sub: 'INDIRECT' },
};

/** Decoy: the snapshot was taken on an estimate N + 3333, so its base_fen is never booked_base_fen. */
const SNAPSHOT_DRIFT_FEN = 3333n;
const SUBSIDY_FEN = 111n;

export async function harness(db: Kysely<DB>) {
  const appId = `bcredit-${randomUUID()}`;
  const clock = new FixedClock(NOW);
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: new Date(BEFORE),
      indirect_enabled: true,
      created_at: new Date(BEFORE),
    })
    .execute();

  const ledger: Ledger = createLedger({ clock });
  const accounts = new Map<string, string>();
  const minors = new Set<string>();
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  // ---- spies around the real collaborators -------------------------------------------------
  const transactions: Transaction<DB>[] = [];
  const pauses: (() => Promise<void>)[] = [];
  let booted: { readonly gate: BeneficiaryGate; readonly service: BeneficiaryCredit } | undefined;
  const realGate = (): BeneficiaryGate => {
    if (booted === undefined) throw new Error('beneficiary-credit harness used before boot()');
    return booted.gate;
  };

  const identityLock = vi.fn<BeneficiaryGateOptions['lockUsers']>((trx, input) =>
    lockUsersForUpdate(trx, input),
  );
  const minorRead = vi.fn<MinorStatusReader['read']>(
    async (_trx, input) => new Set(input.userIds.filter((id) => minors.has(id))),
  );
  const gateOptions: BeneficiaryGateOptions = {
    clock,
    lockUsers: identityLock,
    deletionStatus: createUserDeletionStatusReader({ db }),
    realnameStatus: createRealnameStatusBatchReader({ db }),
    riskState: createRiskStateBatchReader({ db }),
    minors: { read: minorRead },
  };
  const lockUsers = vi.fn<BeneficiaryGate['lockUsers']>((trx, input) =>
    realGate().lockUsers(trx, input),
  );
  const readStates = vi.fn<BeneficiaryGate['readStates']>(async (trx, input) => {
    const states = await realGate().readStates(trx, input);
    const pause = pauses.shift();
    if (pause !== undefined) await pause();
    return states;
  });
  const openUserAccount = vi.fn<Ledger['openUserAccount']>((trx, input) =>
    ledger.openUserAccount(trx, input),
  );
  const lockBalances = vi.fn<Ledger['lockBalances']>((trx, input) =>
    ledger.lockBalances(trx, input),
  );
  const post = vi.fn<Ledger['post']>((trx, voucher) => ledger.post(trx, voucher));
  const readSnapshot = vi.fn<BeneficiaryCreditDependencies['readSnapshot']>((trx, input) =>
    commission.readCommissionSnapshot(trx, input),
  );
  const readOrderNets = vi.fn<BeneficiaryCreditDependencies['readOrderNets']>((trx, input) =>
    getOrderNets(trx, input),
  );
  // Test double of the commission-owned event writer: a plain insert on the same transaction.
  const appendBeneficiaryEvent = vi.fn<BeneficiaryCreditDependencies['appendBeneficiaryEvent']>(
    async (trx, input) => {
      await trx
        .insertInto('commission_split_beneficiary_events')
        .values({
          app_id: input.appId,
          order_id: input.orderId,
          user_id: input.userId,
          role: input.role,
          status: input.status,
          reason: input.reason,
          created_at: clock.now(),
        })
        .execute();
    },
  );

  /**
   * Builds the gate and the service. Seeding happens before; every test calls this (directly or
   * through execute()) before it opens a transaction of its own or asserts a rejection.
   */
  function boot(): BeneficiaryCredit {
    if (booted !== undefined) return booted.service;
    const gate = createBeneficiaryGate(gateOptions);
    const service = createBeneficiaryCredit({
      clock,
      logger,
      ledger: { openUserAccount, lockBalances, post },
      gate: { lockUsers, readStates },
      readSnapshot,
      readOrderNets,
      appendBeneficiaryEvent,
    });
    booted = { gate, service };
    return service;
  }

  function input(
    o: SeededOrder,
    role?: CreditRole,
    patch: Partial<BeneficiaryCreditInput> = {},
  ): BeneficiaryCreditInput {
    const obligation = o.obligation(role);
    return {
      appId,
      orderId: o.orderId,
      beneficiaryCreditId: obligation.beneficiaryCreditId,
      expectedSettleSeq: o.itemSeq,
      closedRef: `batch-item-${obligation.beneficiaryCreditId}`,
      ...patch,
    };
  }

  /** One item execution in its own transaction on `via` (default: the shared pool). */
  function execute(o: SeededOrder, options: ExecuteOptions = {}): Promise<BeneficiaryCreditResult> {
    const service = boot();
    const executor = options.via ?? db;
    const request = input(o, options.role, options.input);
    const onPid = options.onPid;
    return executor.transaction().execute(async (trx) => {
      transactions.push(trx);
      if (onPid !== undefined) onPid(await bounded(trx));
      return service.execute(trx, request);
    });
  }

  /** The next readStates call waits for `pause` after the states were read (locks still held). */
  function pauseAfterStates(pause: () => Promise<void>): void {
    pauses.push(pause);
  }

  // ---- seeding ---------------------------------------------------------------------------------
  async function setRisk(
    executor: Kysely<DB>,
    userId: string,
    state: 'normal' | 'frozen' | 'appealing' | 'banned',
  ): Promise<void> {
    const reasonCategory = state === 'normal' ? null : 'other';
    await executor
      .insertInto('user_risk_state')
      .values({
        user_id: userId,
        app_id: appId,
        state,
        reason: null,
        reason_category: reasonCategory,
        frozen_until: null,
        changed_by: 'test',
        changed_at: clock.now(),
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          state,
          reason_category: reasonCategory,
          changed_at: clock.now(),
        }),
      )
      .execute();
  }

  async function user(state: UserState = 'normal'): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('users')
      .values({
        id,
        app_id: appId,
        nickname: 'synthetic',
        avatar: '',
        invite_code: randomUUID(),
        attr_code: randomUUID(),
        level: 'L1',
        status: state === 'deleting' ? 'deleting' : state === 'deleted' ? 'deleted' : 'normal',
        register_method: 'phone',
      })
      .execute();
    const account = await db
      .transaction()
      .execute((trx) => ledger.openUserAccount(trx, { appId, userId: id }));
    accounts.set(id, account.account_id);
    if (state === 'frozen' || state === 'appealing' || state === 'banned') {
      await setRisk(db, id, state);
    }
    if (state === 'cooling') {
      // An open request still inside its cooling-off window at NOW (BR-CALC-13: not a loss).
      await db
        .insertInto('deletion_requests')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: id,
          status: 'cooling',
          apply_at: new Date(BEFORE),
          cooling_until: new Date('2032-09-20T10:00:00+08:00'),
          balance_snapshot_fen: 0n,
        })
        .execute();
    }
    if (state === 'minor' || state === 'adult') {
      await db
        .insertInto('realname')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: id,
          name_cipher: Buffer.from('synthetic-name'),
          id_no_cipher: Buffer.from('synthetic-id-no'),
          id_no_hmac: randomBytes(32).toString('hex'),
          birth_date_cipher: Buffer.from('synthetic-birth-date'),
          status: 'verified',
          provider: 'synthetic',
          verified_at: new Date(BEFORE),
        })
        .execute();
      if (state === 'minor') minors.add(id);
    }
    return id;
  }

  /** Posts one voucher on its own transaction (balance rows of its user locked first). */
  async function seedVoucher(voucher: PostingVoucher): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const userIds = voucher.beneficiaryUserId === null ? [] : [voucher.beneficiaryUserId];
      if (userIds.length > 0) await ledger.lockBalances(trx, { appId, userIds });
      const result = await ledger.post(trx, voucher);
      return result.voucherId;
    });
  }

  function receivableLine(platform: string, amount: bigint, type: string, sub: string | null) {
    const entry: PostingEntry = {
      account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${platform}` },
      sub_account: 'available',
      amount_fen: amount,
      ledger_type: type,
      sub_type: sub,
      income_type: null,
    };
    return entry;
  }

  /** A beneficiary voucher: debit UNION_RECEIVABLE:{platform}, credit the user's balance. */
  function userVoucher(
    o: { readonly platform: string; readonly orderKey: string },
    key: string,
    person: { readonly userId: string; readonly role: CreditRole },
    amount: bigint,
    kind: string,
    type: string,
    sub: string | null,
  ): PostingVoucher {
    const accountId = accounts.get(person.userId);
    if (accountId === undefined) throw new Error('beneficiary-credit harness: user has no account');
    return {
      appId,
      uniqKey: key,
      bizType: kind === 'CREDIT' ? 'ORDER_CREDIT' : 'ORDER_ADJUST',
      bizId: o.orderKey,
      operator: 'system',
      memo: null,
      orderKey: o.orderKey,
      beneficiaryUserId: person.userId,
      role: person.role,
      voucherKind: kind,
      entries: [
        receivableLine(o.platform, amount, type, sub),
        {
          account: { ownerType: 'user', accountId },
          sub_account: 'available',
          amount_fen: -amount,
          ledger_type: type,
          sub_type: sub,
          income_type: null,
        },
      ],
    };
  }

  /** A platform voucher: debit UNION_RECEIVABLE:{platform}, credit COMMISSION_REVENUE. */
  function platformVoucher(
    o: { readonly platform: string; readonly orderKey: string },
    key: string,
    amount: bigint,
    kind: string,
    type: string,
    sub: string | null,
    memo: string | null = null,
  ): PostingVoucher {
    return {
      appId,
      uniqKey: key,
      bizType: kind === 'SETTLE_ADJUST' ? 'ORDER_ADJUST' : 'ORDER_CREDIT',
      bizId: o.orderKey,
      operator: 'system',
      memo,
      orderKey: o.orderKey,
      beneficiaryUserId: null,
      role: null,
      voucherKind: kind,
      entries: [
        receivableLine(o.platform, amount, type, sub),
        {
          account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
          sub_account: 'available',
          amount_fen: -amount,
          ledger_type: type,
          sub_type: sub,
          income_type: null,
        },
      ],
    };
  }

  async function order(spec: OrderSpec = {}): Promise<SeededOrder> {
    const orderId = randomUUID();
    const platform = spec.platform ?? 'taobao';
    const subOrderId = spec.subOrderId ?? `sub-${randomUUID()}`;
    const key = `${platform}:${subOrderId}`;
    const n1 = spec.settleFen ?? 1000n;
    const reserveBp = spec.reserveBp ?? 1500;
    const deferredRoles: readonly CreditRole[] = spec.deferred ?? [];
    const defaultHeld: readonly CreditRole[] = spec.deferred === undefined ? ['direct'] : [];
    const heldRoles: readonly CreditRole[] = spec.held ?? defaultHeld;
    const origin = spec.origin ?? SETTLE_DIFF;
    const adjust = spec.adjustTo;
    if (adjust !== undefined && adjust < n1) throw new Error('adjustTo must not lower N');
    if (deferredRoles.length > 0 && adjust === undefined)
      throw new Error('deferred needs adjustTo');
    const nFinal = adjust ?? n1;
    const attrAt = new Date(BEFORE);

    const people: SeededPerson[] = [];
    for (const p of spec.people ?? DEFAULT_PEOPLE) {
      const userId = await user(p.state ?? 'normal');
      people.push({ userId, role: p.role, ratioBp: p.ratioBp });
    }
    const ref = { platform, orderKey: key };
    const owner = people.find((p) => p.role === 'self' || p.role === 'share') ?? people[0];

    // The immutable snapshot (version 1), taken on the estimate rawN, not on any settled N.
    const rawN = addFen(n1, SNAPSHOT_DRIFT_FEN);
    const nTotal = addFen(rawN, SUBSIDY_FEN);
    const snap = baseOf(rawN, reserveBp);
    const snapAmounts = people.map((p) => shareOf(snap.base, p.ratioBp));
    const snapUserTotal = snapAmounts.reduce((sum, a) => addFen(sum, a), 0n);

    const first = baseOf(n1, reserveBp);
    const last = baseOf(nFinal, reserveBp);
    const bookedN = nFinal > 0n ? nFinal : 0n;

    await db
      .insertInto('order_keys')
      .values({
        app_id: appId,
        order_id: orderId,
        platform,
        sub_order_id: subOrderId,
        attr_at: attrAt,
        created_at: attrAt,
      })
      .execute();
    await db
      .insertInto('orders')
      .values({
        app_id: appId,
        order_id: orderId,
        platform,
        sub_order_id: subOrderId,
        attr_at: attrAt,
        raw_item_id: 'synthetic',
        user_id: owner?.userId ?? null,
        user_basis: 'param',
        buy_type: people.some((p) => p.role === 'share') ? 'share' : 'self',
        platform_status: 'SETTLED',
        rebate_status: 'CREDITED',
        hold: false,
        rights_pending: false,
        commission_version: 1,
        est_commission_fen: rawN,
        settle_commission_fen: nFinal,
        subsidy_commission_fen: SUBSIDY_FEN,
        initial_est_fen: rawN,
        n_total_fen: nTotal,
        pre_base_deduct_fen: subFen(nTotal, snap.base),
        base_fen: snap.base,
        platform_est_profit_fen: subFen(nTotal, snapUserTotal),
        activity_type: null,
        paid_at: attrAt,
        received_at: attrAt,
        settle_period: PERIOD,
        booked_base_fen: last.base,
        booked_n_fen: bookedN,
        credited_at: new Date(CREDITED_AT),
        quantity: 1,
        refunded_quantity: 0,
        created_at: attrAt,
        updated_at: new Date(CREDITED_AT),
        ...spec.patch,
      })
      .execute();
    await db
      .insertInto('commission_splits')
      .values({
        app_id: appId,
        order_id: orderId,
        rule_version_id: ruleVersionId,
        order_type: people.some((p) => p.role === 'share') ? 'share' : 'self',
        activity_type: null,
        rebate_mode: null,
        paid_at: attrAt,
        paid_at_source: 'platform',
        raw_n_fen: rawN,
        subsidy_commission_fen: SUBSIDY_FEN,
        reserve_bp: reserveBp,
        reserve_fen: snap.reserve,
        tlj_deduct_fen: 0n,
        base_fen: snap.base,
        platform_retain_fen: subFen(snap.base, snapUserTotal),
        beneficiaries: JSON.stringify(
          people.map((p) => ({
            user_id: p.userId,
            role: p.role,
            ratio_bp: p.ratioBp,
            level: 'L1',
            initial_status: 'active',
            forfeit_reason: null,
          })),
        ),
        created_at: attrAt,
      })
      .execute();
    await db
      .insertInto('commission_split_totals')
      .values({
        app_id: appId,
        order_id: orderId,
        commission_version: 1,
        n_total_fen: nTotal,
        pre_base_deduct_fen: subFen(nTotal, snap.base),
        base_fen: snap.base,
        user_share_total_fen: snapUserTotal,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: subFen(nTotal, snapUserTotal),
        created_at: attrAt,
      })
      .execute();
    await db
      .insertInto('commission_split_amounts')
      .values(
        people.map((p, i) => ({
          app_id: appId,
          order_id: orderId,
          commission_version: 1,
          user_id: p.userId,
          role: p.role,
          base_fen: snap.base,
          amount_fen: snapAmounts[i] ?? 0n,
          created_at: attrAt,
        })),
      )
      .execute();
    let seededEvents = 0;
    for (const p of people) {
      await db
        .insertInto('commission_split_beneficiary_events')
        .values({
          app_id: appId,
          order_id: orderId,
          user_id: p.userId,
          role: p.role,
          status: 'active',
          reason: null,
          created_at: attrAt,
        })
        .execute();
      seededEvents += 1;
    }

    // order_settlements: seq 1 = N of R5; seq 2 = the adjusted N; later ones after the item.
    const settlements: { seq: number; fen: bigint; source: string }[] = [
      { seq: 1, fen: n1, source: 'STATEMENT' },
    ];
    if (adjust !== undefined) settlements.push({ seq: 2, fen: adjust, source: 'API' });
    const itemSeq = settlements[settlements.length - 1]!.seq;
    for (const seq of spec.laterSeqs ?? []) {
      settlements.push({ seq, fen: addFen(nFinal, 77n), source: 'API' });
    }
    for (const s of settlements) {
      await db
        .insertInto('order_settlements')
        .values({
          app_id: appId,
          order_id: orderId,
          seq: s.seq,
          source: s.source,
          settle_commission_fen: s.fen,
          settled_at: attrAt,
          content_hash: randomUUID(),
          created_at: attrAt,
        })
        .execute();
    }

    // R5 vouchers: every beneficiary not held, then PLATFORM:CREDIT (retain + reserve).
    const firstShares = people.map((p) => shareOf(first.base, p.ratioBp));
    const firstAssigned = firstShares.reduce((sum, a) => addFen(sum, a), 0n);
    const firstPlatform = addFen(subFen(first.base, firstAssigned), first.reserve);
    for (const [i, p] of people.entries()) {
      const share = firstShares[i] ?? 0n;
      if (heldRoles.includes(p.role) || share === 0n) continue;
      const t = CREDIT_TYPES[p.role];
      const creditUniqKey = `${key}:${p.userId}:${p.role}:CREDIT`;
      await seedVoucher(userVoucher(ref, creditUniqKey, p, share, 'CREDIT', t.type, t.sub));
    }
    if (firstPlatform > 0n) {
      const platformUniqKey = `${key}:PLATFORM:CREDIT`;
      await seedVoucher(
        platformVoucher(ref, platformUniqKey, firstPlatform, 'CREDIT', 'REBATE_CREDIT', null),
      );
    }

    // BR-FUND-09 positive diff at seq 2: credited, not deferred roles get their diff; platform too.
    if (adjust !== undefined) {
      const lastShares = people.map((p) => shareOf(last.base, p.ratioBp));
      const lastAssigned = lastShares.reduce((sum, a) => addFen(sum, a), 0n);
      const lastPlatform = addFen(subFen(last.base, lastAssigned), last.reserve);
      for (const [i, p] of people.entries()) {
        if (heldRoles.includes(p.role) || deferredRoles.includes(p.role)) continue;
        const diff = subFen(lastShares[i] ?? 0n, firstShares[i] ?? 0n);
        if (diff === 0n) continue;
        await seedVoucher(
          userVoucher(
            ref,
            `${key}:${p.userId}:${p.role}:ADJ:2`,
            p,
            diff,
            'SETTLE_ADJUST',
            'SETTLE_ADJUST',
            'SETTLE_DIFF',
          ),
        );
      }
      const platformDiff = subFen(lastPlatform, firstPlatform);
      if (platformDiff !== 0n) {
        await seedVoucher(
          platformVoucher(
            ref,
            `${key}:PLATFORM:ADJ:2`,
            platformDiff,
            'SETTLE_ADJUST',
            'SETTLE_ADJUST',
            'SETTLE_DIFF',
          ),
        );
      }
    }

    // Obligations (BR-FUND-04 ⑫) and the held events of R5.
    const obligations: SeededObligation[] = [];
    for (const p of people) {
      const isHeld = heldRoles.includes(p.role);
      const isDeferred = deferredRoles.includes(p.role);
      if (!isHeld && !isDeferred) continue;
      if (isHeld) {
        await db
          .insertInto('commission_split_beneficiary_events')
          .values({
            app_id: appId,
            order_id: orderId,
            user_id: p.userId,
            role: p.role,
            status: 'held',
            reason: null,
            created_at: new Date(CREDITED_AT),
          })
          .execute();
        seededEvents += 1;
      }
      const beneficiaryCreditId = randomUUID();
      await db
        .insertInto('beneficiary_credits')
        .values({
          beneficiary_credit_id: beneficiaryCreditId,
          app_id: appId,
          order_id: orderId,
          user_id: p.userId,
          role: p.role,
          kind: isHeld ? 'first_credit' : 'deferred',
          opened_by: isHeld ? 'R5' : origin.openedBy,
          opened_ref: isHeld ? `batch-item-r5-${orderId}` : 'seq:2',
          origin_ledger_type: isHeld ? null : origin.ledgerType,
          origin_sub_type: isHeld ? null : origin.subType,
          split_ref: 'commission_version:1',
          status: 'open',
          closed_by: null,
          closed_ref: null,
          voucher_id: null,
          opened_at: new Date(CREDITED_AT),
          closed_at: null,
          ...spec.obligationPatch,
        })
        .execute();
      obligations.push({
        beneficiaryCreditId,
        userId: p.userId,
        role: p.role,
        kind: isHeld ? 'first_credit' : 'deferred',
      });
    }

    return {
      orderId,
      platform,
      subOrderId,
      orderKey: key,
      attrAt,
      itemSeq,
      bookedBaseFen: last.base,
      bookedNFen: bookedN,
      people,
      obligations,
      seededEvents,
      user(role: CreditRole): string {
        const found = people.find((p) => p.role === role);
        if (found === undefined) throw new Error(`no ${role} beneficiary in this order`);
        return found.userId;
      },
      obligation(role?: CreditRole): SeededObligation {
        const found =
          role === undefined ? obligations : obligations.filter((ob) => ob.role === role);
        const only = found[0];
        if (found.length !== 1 || only === undefined) {
          throw new Error(`expected exactly one obligation for ${role ?? 'the order'}`);
        }
        return only;
      },
    };
  }

  // ---- reads -------------------------------------------------------------------------------------
  function read(o: SeededOrder) {
    return db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .executeTakeFirstOrThrow();
  }

  async function lines(): Promise<Line[]> {
    const rows = await db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_vouchers as v', (join) =>
        join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
      )
      .innerJoin('ledger_accounts as a', (join) =>
        join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
      )
      .select([
        'v.uniq_key',
        'a.subject',
        'a.owner_id',
        'e.amount_fen',
        'e.ledger_type',
        'e.sub_type',
      ])
      .where('e.app_id', '=', appId)
      .execute();
    return rows.map((r) => ({
      uniq_key: r.uniq_key,
      subject: r.subject,
      owner_id: r.owner_id,
      amount_fen: r.amount_fen,
      ledger_type: r.ledger_type,
      sub_type: r.sub_type,
    }));
  }

  /** The entries of one voucher as sorted `subject|owner|amount` strings. */
  async function voucherLines(uniqKey: string): Promise<string[]> {
    return (await lines())
      .filter((l) => l.uniq_key === uniqKey)
      .map((l) => `${l.subject}|${l.owner_id}|${String(l.amount_fen)}`)
      .sort();
  }

  /** The entries of one voucher as sorted `subject|ledger_type|sub_type` strings. */
  async function voucherTypes(uniqKey: string): Promise<string[]> {
    return (await lines())
      .filter((l) => l.uniq_key === uniqKey)
      .map((l) => `${l.subject}|${l.ledger_type}|${l.sub_type ?? ''}`)
      .sort();
  }

  async function vouchers() {
    return db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('uniq_key')
      .execute();
  }

  async function voucher(uniqKey: string) {
    return db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .where('uniq_key', '=', uniqKey)
      .executeTakeFirst();
  }

  async function voucherKeys(): Promise<string[]> {
    return (await vouchers()).map((v) => v.uniq_key).sort();
  }

  /** Σ of the signed entries on one subject (debit positive), every voucher of the app. */
  async function subjectNet(subject: string): Promise<bigint> {
    return (await lines())
      .filter((l) => l.subject === subject)
      .reduce((sum, l) => addFen(sum, l.amount_fen), 0n);
  }

  async function balance(userId: string): Promise<bigint> {
    const [row] = await ledger.getBalances(db, { appId, userIds: [userId] });
    if (row === undefined) throw new Error('beneficiary-credit harness: user has no account');
    return row.available_fen;
  }

  /** ledger's BR-FUND-08 / BR-FUND-19 ④⑤ nets of the order, read on a fresh transaction. */
  function nets(o: SeededOrder): Promise<OrderNets> {
    return db.transaction().execute((trx) => getOrderNets(trx, { appId, orderKey: o.orderKey }));
  }

  /** The ⑤ net of one beneficiary key (0 when the key has no voucher). */
  async function netOf(o: SeededOrder, role: CreditRole): Promise<bigint> {
    const found = (await nets(o)).beneficiaries.find(
      (b) => b.beneficiary_user_id === o.user(role) && b.role === role,
    );
    return found?.net_fen ?? 0n;
  }

  function obligations() {
    return db
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('beneficiary_credit_id')
      .execute();
  }

  function obligationRow(beneficiaryCreditId: string) {
    return db
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', appId)
      .where('beneficiary_credit_id', '=', beneficiaryCreditId)
      .executeTakeFirstOrThrow();
  }

  function beneficiaryEvents(o: SeededOrder) {
    return db
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('event_seq')
      .execute();
  }

  /** Events appended after seeding. */
  async function newBeneficiaryEvents(o: SeededOrder) {
    return (await beneficiaryEvents(o)).slice(o.seededEvents);
  }

  /** Everything the item may write for this app, for before / after comparisons. */
  async function state() {
    return {
      orders: await db
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('order_id')
        .execute(),
      vouchers: await vouchers(),
      lines: (await lines()).sort((a, b) =>
        `${a.uniq_key}|${a.subject}|${a.owner_id}` < `${b.uniq_key}|${b.subject}|${b.owner_id}`
          ? -1
          : 1,
      ),
      balances: await db
        .selectFrom('account_balances')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('account_id')
        .execute(),
      obligations: await obligations(),
      beneficiaryEvents: await db
        .selectFrom('commission_split_beneficiary_events')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('event_seq')
        .execute(),
    };
  }

  /** The alert lines of BR-FUND-04 ⑫「跳过并告警」. */
  function alerts(): Record<string, unknown>[] {
    return logs.filter((line) => line['alert'] === ALERT);
  }

  return {
    appId,
    clock,
    db,
    ledger,
    accounts,
    minors,
    logs,
    transactions,
    identityLock,
    minorRead,
    lockUsers,
    readStates,
    openUserAccount,
    lockBalances,
    post,
    readSnapshot,
    readOrderNets,
    appendBeneficiaryEvent,
    boot,
    input,
    execute,
    pauseAfterStates,
    setRisk,
    user,
    order,
    seedVoucher,
    userVoucher,
    platformVoucher,
    read,
    lines,
    voucherLines,
    voucherTypes,
    vouchers,
    voucher,
    voucherKeys,
    subjectNet,
    balance,
    nets,
    netOf,
    obligations,
    obligationRow,
    beneficiaryEvents,
    newBeneficiaryEvents,
    state,
    alerts,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

// ---- BR-FUND-05 / BR-FUND-04 ⑫ keys (written out from the rule text) -----------------------------
export const creditKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:${o.user(role)}:${role}:CREDIT`;
export const adjDeferredKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:${o.user(role)}:${role}:ADJ:DEFERRED:${o.obligation(role).beneficiaryCreditId}`;
export const forfeitKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:PLATFORM:FORFEIT:${o.user(role)}:${role}`;
export const forfeitDeferredKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:PLATFORM:FORFEIT:${o.user(role)}:${role}:DEFERRED:${o.obligation(role).beneficiaryCreditId}`;
export const platformKey = (o: SeededOrder) => `${o.orderKey}:PLATFORM:CREDIT`;
export const receivable = (o: SeededOrder) => `UNION_RECEIVABLE:${o.platform}`;

/** The two entries of a beneficiary voucher, in voucherLines form. */
export function userLines(o: SeededOrder, role: CreditRole, amount: bigint): string[] {
  return [
    `${receivable(o)}|platform|${String(amount)}`,
    `USER_BALANCE|${o.user(role)}|${String(-amount)}`,
  ].sort();
}

/** The two entries of a platform FORFEIT voucher, in voucherLines form. */
export function platformLines(o: SeededOrder, amount: bigint): string[] {
  return [
    `${receivable(o)}|platform|${String(amount)}`,
    `COMMISSION_REVENUE|platform|${String(-amount)}`,
  ].sort();
}
