import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';
import { expect } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderPipelineDeps,
  type OrderSourcePorts,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture, snapshot, traceQueries } from '../attribution/kit.ts';
import { at, capture, log, matched, sourcePorts } from './kit.ts';

export { capture, fixture, snapshot, traceQueries } from '../attribution/kit.ts';
export { scenario } from '../platform-status/kit.ts';
export const EMPTY_SOURCE = {
  source_match: null,
  link_id: null,
  source_scene: null,
  agent_session_id: null,
};

// Only normalized DTOs and in-memory read ports; no platform recordings or real adapters.
export async function sourcesFor(f: Awaited<ReturnType<typeof fixture>>) {
  const linkId = randomUUID();
  const row = log({
    link_id: linkId,
    user_id: f.userId,
    platform: f.ctx.platform,
    pid_scene: 'share',
    created_at: at('2026-10-14T07:08:09Z'),
    agent_session_id: randomUUID(),
  });
  await f.db
    .insertInto('links')
    .values({
      app_id: f.ctx.app_id,
      link_id: linkId,
      user_id: f.userId,
      platform: f.ctx.platform,
      scene: 'agent',
      pid_scene: 'share',
      product_key: 'pdd:123',
      agent_session_id: row.agent_session_id,
      expire_at: at('2026-11-01T01:02:03Z'),
      created_at: at('2026-10-13T04:05:06Z'),
      updated_at: at('2026-10-13T05:06:07Z'),
    })
    .execute();
  const fakes = sourcePorts([row]);
  return { ...fakes, row, expected: matched(row) };
}

export async function fresh(db: Kysely<DB>) {
  const traced = traceQueries(db);
  const f = await fixture(traced.db);
  const sources = await sourcesFor(f);
  traced.queries.length = 0;
  return { ...f, sources, queries: traced.queries, read: () => snapshot(db, f.ctx.app_id) };
}

export function runFresh(
  f: Awaited<ReturnType<typeof fresh>>,
  extra: Partial<OrderPipelineDeps> = {},
) {
  return capture(() =>
    createOrderPipeline({ ...f.deps, sources: f.sources.ports, ...extra }).process(
      f.incoming,
      f.ctx,
    ),
  );
}

export function runUpdate(
  f: Awaited<ReturnType<typeof import('../platform-status/kit.ts').scenario>>,
  sources: OrderSourcePorts | undefined,
  incoming: UnionOrder = f.next(),
  extra: Partial<OrderUpdateDeps> = {},
  omitPids = false,
) {
  return capture(() => {
    const deps: OrderUpdateDeps = {
      ...f.updateDeps,
      ...(sources ? { sources } : {}),
      pids: f.deps.pids,
      ...extra,
    };
    const { pids: unusedPids, ...withoutPids } = deps;
    void unusedPids;
    const updateStep = createOrderUpdateStep(omitPids ? withoutPids : deps);
    return createOrderPipeline({ ...f.deps, updateStep }).process(incoming, f.ctx);
  });
}

export function business(row: Selectable<DB['orders']>) {
  const keys = [
    'user_id',
    'user_basis',
    'buy_type',
    'scene_basis',
    'platform_status',
    'rebate_status',
    'product_key',
    'shop_id',
    'attr_at',
    'locked',
    'hold',
    'rights_pending',
    'commission_version',
    'pay_amount_fen',
    'est_commission_fen',
    'settle_commission_fen',
    'subsidy_commission_fen',
    'booked_base_fen',
    'booked_n_fen',
    'initial_est_fen',
    'n_total_fen',
    'pre_base_deduct_fen',
    'base_fen',
    'platform_est_profit_fen',
    'commission_rate_bp',
    'commission_rate_min_bp',
    'commission_rate_max_bp',
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

export function expectWindow(
  f: Awaited<ReturnType<typeof fixture>>,
  s: Awaited<ReturnType<typeof sourcesFor>>,
) {
  expect(s.linkLogs).toHaveBeenCalledExactlyOnceWith({
    appId: f.ctx.app_id,
    userId: f.userId,
    platform: f.ctx.platform,
    from: at('2026-09-30T16:00:00Z'),
    to: at('2026-10-15T16:00:00Z'),
  });
}

export function expectSourceWrite(queries: { sql: string }[], kind: 'insert' | 'update') {
  const writes = queries.filter((q) => /^(insert into|update) "app"\."orders"/i.test(q.sql));
  expect(writes).toHaveLength(1);
  const statement = writes[0]!.sql;
  expect(statement).toMatch(kind === 'insert' ? /^insert into/i : /^update/i);
  const set = statement.split(' where ')[0]!;
  for (const column of ['source_match', 'source_scene', 'link_id', 'agent_session_id']) {
    expect(set).toContain(`"${column}"`);
  }
  if (kind === 'update') {
    expect(set).toContain('"user_id"');
    const where = statement.split(' where ')[1]!;
    expect(where).toMatch(/"source_match" is null/i);
    expect(where).toMatch(/"user_id" is null/i);
    expect(where).toContain('"row_version"');
    expect(where).toContain('"locked"');
  }
}

export function expectPrivateLogs(f: Awaited<ReturnType<typeof fixture>>, lk = 'a1b2c3') {
  const calls = [
    ...f.logger.info.mock.calls,
    ...f.logger.warn.mock.calls,
    ...f.logger.error.mock.calls,
  ];
  for (const args of calls) {
    const fields = args[0] as Record<string, unknown>;
    expect(
      Object.values(fields).every((value) => value === null || typeof value !== 'object'),
    ).toBe(true);
    const text = JSON.stringify(args);
    for (const value of [f.userId, f.incoming.sub_order_id!, lk]) expect(text).not.toContain(value);
    for (const key of ['user_id', 'lk', 'sub_order_id']) expect(fields).not.toHaveProperty(key);
  }
}
