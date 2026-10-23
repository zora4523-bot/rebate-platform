// Shared helpers of the B1-09b pipeline rule tests (08 BR-ATTR-26; BR-ATTR-01 ③). The order fixture
// is the B1-08h one (taobao, relation_id R8 bound to the fixture user at attr_at); the blocklist ports
// are the real risk ones (B1-09a) wrapped in spies, over the same database. The settlement port
// rebate.onBlacklistHit and the event bus are fakes: rebate_status is not written here, the tests
// set it directly to stand for settlement's earlier transitions.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderBlacklistDeps,
  type OrderBlacklistPorts,
  type OrderBlacklistRebatePort,
  type OrderPipelineDeps,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  createOrderBlocklistPorts as CreatePorts,
} from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { ATTR, at, capture, fixture, snapshot } from '../attribution/kit.ts';
import { CHANNEL, PARENT_MISS, SUFFIX } from './plan-kit.ts';

export { ATTR, at, capture } from '../attribution/kit.ts';

// Same as the risk rule tests: the risk public surface is loaded at run time so its Nest
// controllers stay out of the pure TS test project.
const { createOrderBlocklistPorts } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createOrderBlocklistPorts: typeof CreatePorts };

/** attr_at of the fixture order (paid_at, no deposit). */
export const ATTR_AT = at(ATTR);

export interface BlacklistOptions {
  /** attr.blacklist.order_suffix_void_enabled; default false. */
  readonly suffixOn?: boolean;
  /** Leave rebate.onBlacklistHit out (not wired yet). */
  readonly noRebatePort?: boolean;
  /** No binding at attr_at: the order goes to the unattributed pool. */
  readonly unattributed?: boolean;
}

export async function setup(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
  options: BlacklistOptions = {},
) {
  const f = await fixture(db, {
    platform: 'taobao',
    parent_order_id: PARENT_MISS,
    attr_params: { relation_id: CHANNEL, sub_union_id: null, custom_parameters: null },
    ...patch,
  });
  f.findBindings.mockResolvedValue(
    options.unattributed
      ? []
      : [
          {
            user_id: f.userId,
            bound_at: at('2026-09-20T00:00:00.000Z'),
            released_at: null,
            cooldown_until: null,
          },
        ],
  );
  const key = randomBytes(32);
  const crypto = {
    blindIndex(value: string, context: string) {
      return createHmac('sha256', key).update(context).update('\0').update(value).digest('hex');
    },
  };
  const real = createOrderBlocklistPorts({ clock: f.clock, crypto });
  const match = vi.fn<OrderBlacklistPorts['match']>((trx, input) => real.match(trx, input));
  const recordHit = vi.fn<OrderBlacklistPorts['recordHit']>((trx, input) =>
    real.recordHit(trx, input),
  );
  const suffixVoidEnabled = vi
    .fn<OrderBlacklistDeps['suffixVoidEnabled']>()
    .mockResolvedValue(options.suffixOn ?? false);
  const blacklist: OrderBlacklistDeps = { blocklist: { match, recordHit }, suffixVoidEnabled };
  const onBlacklistHit = vi
    .fn<OrderBlacklistRebatePort['onBlacklistHit']>()
    .mockResolvedValue(undefined);
  const publish = vi
    .fn<NonNullable<OrderPipelineDeps['events']>['publish']>()
    .mockResolvedValue({ eventId: randomUUID(), duplicate: false });
  const deps: OrderPipelineDeps = {
    ...f.deps,
    rebate: options.noRebatePort
      ? { onImported: f.onImported }
      : { onImported: f.onImported, onBlacklistHit },
    events: { publish },
    blacklist,
  };
  return {
    ...f,
    /** The B1-08h deps: no blacklist step, no settlement blacklist port, no event bus. */
    plainDeps: f.deps,
    crypto,
    match,
    recordHit,
    suffixVoidEnabled,
    blacklist,
    onBlacklistHit,
    publish,
    deps,
    run: (incoming: UnionOrder = f.incoming) =>
      capture(() => createOrderPipeline(deps).process(incoming, f.ctx)),
    read: () => state(db, f.ctx.app_id),
    hmac: (dimension: string, value: string) => crypto.blindIndex(value, `blocklist.${dimension}`),
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * An order already in the table (first import without the blacklist step, as before B1-09b), then
 * the update pipeline with the step. rebate_status set directly stands for settlement's earlier
 * transitions.
 */
export async function existing(
  db: Kysely<DB>,
  rebateStatus: string,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
  options: BlacklistOptions = {},
) {
  const f = await setup(db, patch, options);
  const imported = await createOrderPipeline(f.plainDeps).process(f.incoming, f.ctx);
  expect(imported.kind).toBe('inserted');
  await db
    .updateTable('orders')
    .set({ rebate_status: rebateStatus })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  const before = (await f.read()).orders[0];
  expect(before).toBeDefined();
  if (!before) throw new Error('fixture order missing');
  f.clock.advanceMs(60_000);
  f.onImported.mockClear();
  f.match.mockClear();
  f.recordHit.mockClear();
  f.publish.mockClear();
  f.logger.info.mockClear();
  f.logger.warn.mockClear();
  f.logger.error.mockClear();
  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>().mockResolvedValue(undefined);
  const onUnmappedStatus = vi
    .fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>()
    .mockResolvedValue(undefined);
  const updateDeps: OrderUpdateDeps = {
    clock: f.clock,
    users: f.deps.users,
    bindings: f.deps.bindings,
    statusMaps: f.deps.statusMaps,
    pids: f.deps.pids,
    rebate: options.noRebatePort
      ? { onUpdated, onUnmappedStatus }
      : { onUpdated, onUnmappedStatus, onBlacklistHit: f.onBlacklistHit },
    events: { publish: f.publish },
    logger: f.logger,
    blacklist: f.blacklist,
  };
  const made = await capture(() => createOrderUpdateStep(updateDeps));
  expect(made).toMatchObject({ ok: true });
  if (!made.ok) throw made.error;
  const pipeline = createOrderPipeline({ ...f.deps, updateStep: made.value });
  const next = (change: Partial<UnionOrder> = {}): UnionOrder => {
    const platformClock = new FixedClock(f.clock.now().toISOString());
    platformClock.advanceMs(-11_000);
    return {
      ...f.incoming,
      modified_at: platformClock.now(),
      raw_payload_id: '202',
      ...change,
    };
  };
  return {
    ...f,
    before,
    onUpdated,
    onUnmappedStatus,
    updateDeps,
    next,
    update: (incoming: UnionOrder = next()) => capture(() => pipeline.process(incoming, f.ctx)),
  };
}

export async function seedChannel(
  db: Kysely<DB> | Transaction<DB>,
  f: Fixture,
  overrides: Partial<{
    value: string;
    union_account_id: string;
    start_at: Date;
    end_at: Date | null;
    status: string;
  }> = {},
) {
  const id = randomUUID();
  await db
    .insertInto('blocklist')
    .values({
      id,
      app_id: f.ctx.app_id,
      dimension: 'channel',
      value: CHANNEL,
      value_hmac: null,
      platform: 'taobao',
      union_account_id: f.ctx.union_account_id,
      start_at: at('2026-10-10T07:00:00.000Z'),
      end_at: null,
      expire_at: null,
      status: 'active',
      violation_type: 'other',
      created_by: 'fixture-admin',
      created_at: at('2026-10-10T07:00:00.000Z'),
      updated_at: at('2026-10-10T07:00:00.000Z'),
      ...overrides,
    })
    .execute();
  return id;
}

export async function seedSuffix(
  db: Kysely<DB> | Transaction<DB>,
  f: Fixture,
  overrides: Partial<{ value: string; status: string }> = {},
) {
  const id = randomUUID();
  await db
    .insertInto('blocklist')
    .values({
      id,
      app_id: f.ctx.app_id,
      dimension: 'order_no_suffix',
      value: SUFFIX,
      value_hmac: null,
      platform: 'taobao',
      union_account_id: null,
      start_at: null,
      end_at: null,
      expire_at: null,
      status: 'active',
      violation_type: 'other',
      created_by: 'fixture-admin',
      created_at: at('2026-10-10T07:00:00.000Z'),
      updated_at: at('2026-10-10T07:00:00.000Z'),
      ...overrides,
    })
    .execute();
  return id;
}

export async function state(db: Kysely<DB>, appId: string) {
  return {
    ...(await snapshot(db, appId)),
    hits: await db
      .selectFrom('risk_hits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** risk_hits columns this task decides (the port fills the rest). */
export function hitView(row: Awaited<ReturnType<typeof state>>['hits'][number]) {
  return {
    user_id: row.user_id,
    rule_id: row.rule_id,
    risk_action: row.risk_action,
    dimension: row.dimension,
    value_hmac: row.value_hmac,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
  };
}

/** Columns BR-ATTR-26 says the blacklist never touches (only rebate_status, via settlement). */
export function ownership(row: Awaited<ReturnType<typeof state>>['orders'][number]) {
  return {
    user_id: row.user_id,
    user_basis: row.user_basis,
    buy_type: row.buy_type,
    scene_basis: row.scene_basis,
    rebate_status: row.rebate_status,
    reason: row.reason,
  };
}

export function publishedOf(f: Fixture, name: string) {
  return f.publish.mock.calls.filter(([, event]) => event.name === name);
}

/** Logs are flat and carry neither the order numbers nor the buyer parameters (orders AGENTS 10). */
export function expectSafeLogs(f: Fixture, privateValues: readonly string[]) {
  const logs = [
    ...f.logger.info.mock.calls,
    ...f.logger.warn.mock.calls,
    ...f.logger.error.mock.calls,
  ];
  for (const args of logs) {
    const fields = args[0] as Record<string, unknown>;
    expect(Object.values(fields).every((v) => v === null || typeof v !== 'object')).toBe(true);
    const text = JSON.stringify(args);
    for (const value of [f.incoming.sub_order_id, ...privateValues]) {
      expect(text).not.toContain(value);
    }
  }
}
