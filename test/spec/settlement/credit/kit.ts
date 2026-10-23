// Shared harness of the B2-04m rule tests (single-order credit transaction, R5).
// Synthetic rows only; expected amounts are written by hand in the tests (or derived in the
// property body from the BR-CALC-02 / BR-CALC-04 formulas), never by calling the planner.
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
  createRealnameStatusBatchReader,
  createUserDeletionStatusReader,
  lockUsersForUpdate,
} from '../../../../apps/api/src/modules/identity/index.ts';
import { createLedger, type Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createBeneficiaryGate,
  createCreditOrder,
  type BeneficiaryGate,
  type BeneficiaryGateOptions,
  type CreditOrder,
  type CreditOrderDependencies,
  type CreditOrderInput,
  type CreditOrderResult,
  type CreditRole,
  type MinorStatusReader,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';

// Through commission's public entry, loaded at run time like the other settlement rule tests do.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as { readCommissionSnapshot: CreditOrderDependencies['readSnapshot'] };

export const NOW = '2032-07-24T10:00:00+08:00';
export const BEFORE = '2032-06-20T10:00:00+08:00';
export const PERIOD = '2032-06';
export const TIMEOUT = 120_000;

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
    if (pools === undefined) throw new Error('credit pools are not open');
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
  'normal' | 'frozen' | 'appealing' | 'banned' | 'deleting' | 'deleted' | 'minor' | 'adult';

export interface PersonSpec {
  readonly role: CreditRole;
  readonly ratioBp: number;
  /** An existing user of the harness; a new one (with `state`) when omitted. */
  readonly userId?: string;
  readonly state?: UserState;
  readonly initialStatus?: 'active' | 'forfeited';
}

export interface OrderSpec {
  readonly people?: readonly PersonSpec[];
  /** N: the union settlement commission (orders.settle_commission_fen and order_settlements). */
  readonly settleFen?: bigint;
  readonly reserveBp?: number;
  readonly platform?: string;
  readonly subOrderId?: string;
  /** order_settlements seqs; default [1]. */
  readonly seqs?: readonly number[];
  readonly patch?: Partial<Insertable<DB['orders']>>;
}

export interface SeededPerson {
  readonly userId: string;
  readonly role: CreditRole;
  readonly ratioBp: number;
  readonly initialStatus: 'active' | 'forfeited';
}

export interface SeededOrder {
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly orderKey: string;
  readonly attrAt: Date;
  /** Greatest order_settlements seq (1 when there is none). */
  readonly seq: number;
  readonly settleFen: bigint;
  readonly people: readonly SeededPerson[];
  user(role: CreditRole): string;
}

export const DEFAULT_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
];

export interface CreditOptions {
  /** Executor of the credit transaction (another pool, a traced or a faulty one). */
  readonly via?: Kysely<DB>;
  readonly input?: Partial<CreditOrderInput>;
  /** Called with the backend pid before the credit starts (lock / statement timeouts set). */
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

/** Every UPDATE of orders matches no row in PostgreSQL (WHERE false), however often it is retried. */
export function ordersCasMisses(db: Kysely<DB>) {
  let misses = 0;
  const conflicted = db.withPlugin({
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') {
        const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        if (/^update\s+(?:"app"\.)?"orders"/i.test(compiled.sql)) {
          misses += 1;
          return {
            ...args.node,
            where: { kind: 'WhereNode', where: sql<boolean>`false`.toOperationNode() },
          };
        }
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: conflicted, misses: () => misses };
}

/** floor(B × ratio / 10000), the BR-CALC-04 share. */
export function shareOf(base: bigint, ratioBp: number): bigint {
  return mulDivFloor(base, BigInt(ratioBp), 10000n);
}

/** BR-CALC-02 with tlj_deduct_fen = 0: B and reserve_fen of N. */
export function baseOf(n: bigint, reserveBp: number): { base: bigint; reserve: bigint } {
  const positive = n > 0n ? n : 0n;
  const base = mulDivFloor(positive, BigInt(10000 - reserveBp), 10000n);
  return { base, reserve: subFen(positive, base) };
}

export async function harness(db: Kysely<DB>) {
  const appId = `credit-${randomUUID()}`;
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
  let booted: { readonly gate: BeneficiaryGate; readonly service: CreditOrder } | undefined;
  const realGate = (): BeneficiaryGate => {
    if (booted === undefined) throw new Error('credit harness used before boot()');
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
  const readSnapshot = vi.fn<CreditOrderDependencies['readSnapshot']>((trx, input) =>
    commission.readCommissionSnapshot(trx, input),
  );
  const readTljDeductFen = vi.fn<CreditOrderDependencies['readTljDeductFen']>(async () => 0n);
  // Test double of the commission-owned event writer: a plain insert on the same transaction.
  const appendBeneficiaryEvent = vi.fn<CreditOrderDependencies['appendBeneficiaryEvent']>(
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
  // Transactional event marker, like the platform outbox: rolls back with the credit.
  const publish = vi.fn<CreditOrderDependencies['events']['publish']>(async (trx, event) => {
    const eventId = event.eventId ?? randomUUID();
    await trx
      .insertInto('event_log')
      .values({
        app_id: event.appId,
        event_id: eventId,
        name: event.name,
        payload: JSON.stringify(event.payload),
        occurred_at: clock.now(),
        created_at: clock.now(),
      })
      .execute();
    return { eventId, duplicate: false };
  });

  /**
   * Builds the gate and the service. Seeding happens before; every test calls this (directly or
   * through credit()) before it opens a transaction of its own or asserts a rejection.
   */
  function boot(): CreditOrder {
    if (booted !== undefined) return booted.service;
    const gate = createBeneficiaryGate(gateOptions);
    const service = createCreditOrder({
      clock,
      logger,
      ledger: { openUserAccount, lockBalances, post },
      gate: { lockUsers, readStates },
      readSnapshot,
      readTljDeductFen,
      appendBeneficiaryEvent,
      events: { publish },
    });
    booted = { gate, service };
    return service;
  }

  function input(o: SeededOrder, patch: Partial<CreditOrderInput> = {}): CreditOrderInput {
    return {
      appId,
      orderId: o.orderId,
      expectedSettleSeq: o.seq,
      openedRef: `batch-item-${o.orderId}`,
      ...patch,
    };
  }

  /** One credit in its own transaction on `via` (default: the shared pool). */
  function credit(o: SeededOrder, options: CreditOptions = {}): Promise<CreditOrderResult> {
    const service = boot();
    const executor = options.via ?? db;
    const request = input(o, options.input);
    const onPid = options.onPid;
    return executor.transaction().execute(async (trx) => {
      transactions.push(trx);
      if (onPid !== undefined) onPid(await bounded(trx));
      return service.credit(trx, request);
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

  async function order(spec: OrderSpec = {}): Promise<SeededOrder> {
    const orderId = randomUUID();
    const platform = spec.platform ?? 'taobao';
    const subOrderId = spec.subOrderId ?? `sub-${randomUUID()}`;
    const n = spec.settleFen ?? 1000n;
    const reserveBp = spec.reserveBp ?? 1500;
    const seqs = spec.seqs ?? [1];
    const attrAt = new Date(BEFORE);
    const people: SeededPerson[] = [];
    for (const p of spec.people ?? DEFAULT_PEOPLE) {
      people.push({
        userId: p.userId ?? (await user(p.state ?? 'normal')),
        role: p.role,
        ratioBp: p.ratioBp,
        initialStatus: p.initialStatus ?? 'active',
      });
    }
    const owner = people.find((p) => p.role === 'self' || p.role === 'share') ?? people[0];
    const { base, reserve } = baseOf(n, reserveBp);
    const amounts = people.map((p) =>
      p.initialStatus === 'active' ? shareOf(base, p.ratioBp) : 0n,
    );
    const userTotal = amounts.reduce((sum, a) => addFen(sum, a), 0n);

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
        rebate_status: 'WAITING',
        hold: false,
        rights_pending: false,
        commission_version: 1,
        est_commission_fen: n,
        settle_commission_fen: seqs.length === 0 ? null : n,
        paid_at: attrAt,
        received_at: attrAt,
        settle_period: PERIOD,
        quantity: 1,
        refunded_quantity: 0,
        created_at: attrAt,
        updated_at: attrAt,
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
        raw_n_fen: n,
        subsidy_commission_fen: 0n,
        reserve_bp: reserveBp,
        reserve_fen: reserve,
        tlj_deduct_fen: 0n,
        base_fen: base,
        platform_retain_fen: subFen(base, userTotal),
        beneficiaries: JSON.stringify(
          people.map((p) => ({
            user_id: p.userId,
            role: p.role,
            ratio_bp: p.ratioBp,
            level: 'L1',
            initial_status: p.initialStatus,
            forfeit_reason: p.initialStatus === 'forfeited' ? 'deleted' : null,
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
        n_total_fen: n,
        pre_base_deduct_fen: subFen(n, base),
        base_fen: base,
        user_share_total_fen: userTotal,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: subFen(n, userTotal),
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
          base_fen: base,
          amount_fen: amounts[i] ?? 0n,
          created_at: attrAt,
        })),
      )
      .execute();
    for (const p of people) {
      await db
        .insertInto('commission_split_beneficiary_events')
        .values({
          app_id: appId,
          order_id: orderId,
          user_id: p.userId,
          role: p.role,
          status: p.initialStatus,
          reason: p.initialStatus === 'forfeited' ? 'deleted' : null,
          created_at: attrAt,
        })
        .execute();
    }
    for (const seq of seqs) {
      await db
        .insertInto('order_settlements')
        .values({
          app_id: appId,
          order_id: orderId,
          seq,
          source: 'API',
          settle_commission_fen: n,
          settled_at: attrAt,
          content_hash: randomUUID(),
          created_at: attrAt,
        })
        .execute();
    }
    return {
      orderId,
      platform,
      subOrderId,
      orderKey: `${platform}:${subOrderId}`,
      attrAt,
      seq: seqs.length === 0 ? 1 : Math.max(...seqs),
      settleFen: n,
      people,
      user(role: CreditRole): string {
        const found = people.find((p) => p.role === role);
        if (found === undefined) throw new Error(`no ${role} beneficiary in this order`);
        return found.userId;
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

  async function vouchers() {
    return db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('uniq_key')
      .execute();
  }

  async function voucherKeys(): Promise<string[]> {
    return (await vouchers()).map((v) => v.uniq_key).sort();
  }

  /** Σ of the signed entries on one subject (debit positive). */
  async function subjectNet(subject: string): Promise<bigint> {
    return (await lines())
      .filter((l) => l.subject === subject)
      .reduce((sum, l) => addFen(sum, l.amount_fen), 0n);
  }

  async function balance(userId: string): Promise<bigint> {
    const [row] = await ledger.getBalances(db, { appId, userIds: [userId] });
    if (row === undefined) throw new Error('credit harness: user has no account');
    return row.available_fen;
  }

  function obligations() {
    return db
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('beneficiary_credit_id')
      .execute();
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

  /** Events appended after seeding (the seeded initial ones are the first `people.length`). */
  async function newBeneficiaryEvents(o: SeededOrder) {
    return (await beneficiaryEvents(o)).slice(o.people.length);
  }

  function history(o: SeededOrder) {
    return db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('id')
      .execute();
  }

  function published() {
    return db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }

  /** Everything the credit may write for this app, for before / after comparisons. */
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
      history: await db
        .selectFrom('order_status_history')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      events: await published(),
    };
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
    readTljDeductFen,
    appendBeneficiaryEvent,
    publish,
    boot,
    gate: (): BeneficiaryGate => {
      boot();
      return realGate();
    },
    input,
    credit,
    pauseAfterStates,
    setRisk,
    user,
    order,
    read,
    lines,
    voucherLines,
    vouchers,
    voucherKeys,
    subjectNet,
    balance,
    obligations,
    beneficiaryEvents,
    newBeneficiaryEvents,
    history,
    published,
    state,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export const creditKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:${o.user(role)}:${role}:CREDIT`;
export const platformKey = (o: SeededOrder) => `${o.orderKey}:PLATFORM:CREDIT`;
export const forfeitKey = (o: SeededOrder, role: CreditRole) =>
  `${o.orderKey}:PLATFORM:FORFEIT:${o.user(role)}:${role}`;
export const receivable = (o: SeededOrder) => `UNION_RECEIVABLE:${o.platform}`;

/** The two entries of a user CREDIT voucher, in voucherLines form. */
export function userCreditLines(o: SeededOrder, role: CreditRole, amount: bigint): string[] {
  return [
    `${receivable(o)}|platform|${String(amount)}`,
    `USER_BALANCE|${o.user(role)}|${String(-amount)}`,
  ].sort();
}

/** The two entries of a PLATFORM:CREDIT or PLATFORM:FORFEIT voucher, in voucherLines form. */
export function platformLines(o: SeededOrder, amount: bigint): string[] {
  return [
    `${receivable(o)}|platform|${String(amount)}`,
    `COMMISSION_REVENUE|platform|${String(-amount)}`,
  ].sort();
}
