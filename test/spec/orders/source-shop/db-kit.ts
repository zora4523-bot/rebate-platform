import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import { expect } from 'vitest';
import { business, type fixture } from '../source-backfill/db-kit.ts';

export {
  EMPTY_SOURCE,
  fresh,
  runFresh,
  runUpdate,
  scenario,
  sourcesFor,
} from '../source-backfill/db-kit.ts';
export { at, capture, matched, NONE } from '../source-backfill/kit.ts';

export function stableBusiness(row: Selectable<DB['orders']>) {
  const { shop_id: ignored, ...rest } = business(row);
  void ignored;
  return rest;
}

export function expectShopCas(queries: { sql: string }[], attributing = false) {
  const writes = queries.filter((q) => /^update "app"\."orders"/i.test(q.sql));
  expect(writes).toHaveLength(1);
  const [set, where] = writes[0]!.sql.split(' where ');
  for (const name of ['shop_id', 'source_match', 'source_scene', 'link_id', 'agent_session_id']) {
    expect(set).toContain(`"${name}"`);
  }
  expect(where).toMatch(/"source_match" is null/i);
  for (const key of ['app_id', 'order_id', 'attr_at', 'row_version', 'platform_status']) {
    expect(where).toContain(`"${key}"`);
  }
  expect(set).not.toContain('"product_key"');
  if (!attributing) {
    expect(set).not.toContain('"user_id"');
    expect(set).not.toContain('"buy_type"');
    expect(set).not.toContain('"platform_status"');
    expect(set).not.toContain('"rebate_status"');
    expect(where).not.toMatch(/"user_id" is null/i);
  }
}

export function expectPrivate(f: Awaited<ReturnType<typeof fixture>>, shopId = '73129') {
  const calls = [
    ...f.logger.info.mock.calls,
    ...f.logger.warn.mock.calls,
    ...f.logger.error.mock.calls,
  ];
  for (const args of calls) {
    const fields = args[0] as Record<string, unknown>;
    expect(Object.values(fields).every((v) => v === null || typeof v !== 'object')).toBe(true);
    for (const key of ['shop_id', 'shopId', 'user_id', 'userId', 'sub_order_id', 'subOrderId']) {
      expect(fields).not.toHaveProperty(key);
    }
    for (const value of [shopId, f.userId, f.incoming.sub_order_id!]) {
      expect(Object.values(fields)).not.toContain(value);
    }
  }
}

export function expectPendingLog(f: Awaited<ReturnType<typeof fixture>>) {
  const logs = f.logger.info.mock.calls.filter(([fields]) => fields.outcome === 'source_pending');
  expect(logs).toHaveLength(1);
  expect(logs[0]![0]).toMatchObject({
    outcome: 'source_pending',
    platform: 'pdd',
    app_id: f.ctx.app_id,
  });
  expectPrivate(f);
}
