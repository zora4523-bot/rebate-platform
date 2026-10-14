import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createUnionBindingsWithPddQuery,
  type PddQueryBindingsOptions,
} from '../../../../apps/api/src/modules/linking/application/union-bindings-pdd.ts';
import { createUnionAuthReads } from '../../../../apps/api/src/modules/linking/application/union-auth-reads.ts';
import type { Caller } from '../../../../apps/api/src/modules/linking/ports.ts';
import { createIdempotency, FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  type UnionAdapter,
  type UnionPidService,
} from '../../../../apps/api/src/modules/union/index.ts';
import { NOW, seed, type BindingStatus } from '../open-pdd-auth/database.ts';
import { outcome, type Query } from '../open-pdd-auth/kit.ts';
import { validate } from '../bindings/assertions.ts';
import { conflicts } from '../relation-conflict/records.ts';

export { outcome };
export const TIMEOUT = 60_000;

export async function fixture(db: Kysely<DB>, binding: BindingStatus = 'invalid') {
  const s = await seed(db);
  const bindingId = await s.bind(binding);
  const clock = new FixedClock(NOW);
  const current = vi.fn(async (): Promise<Caller> => ({
    appId: s.appId,
    userId: s.a.userId,
    deviceId: s.a.deviceId,
  }));
  const attrCode = vi.fn(async (): Promise<string | null> => s.a.attr);
  const getActivePid = vi.fn<UnionPidService['getActivePid']>(async () => ({
    id: randomUUID(),
    app_id: s.appId,
    platform: 'pdd',
    pid_scene: 'self_buy',
    pid: 'synthetic-self-buy',
    union_account_id: s.accountId,
    site_id: null,
    status: 'active',
    row_version: 0,
    hjy_ignore_confirmed_at: clock.now(),
    hjy_ignore_evidence_path: 'synthetic/evidence',
    created_at: clock.now(),
    updated_at: clock.now(),
  }));
  const query = vi.fn<Query>(async () => ({ authorized: true }));
  const demo = new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'synthetic-bindings-query',
    clock,
    environment: 'test',
  });
  const adapter: UnionAdapter = {
    platform: 'pdd',
    searchItems: (q, c) => demo.searchItems(q, c),
    getItem: (r, c) => demo.getItem(r, c),
    resolveLink: (r, c) => demo.resolveLink(r, c),
    listOrders: (w, o, c) => demo.listOrders(w, o, c),
    convert: vi.fn((r, i, c) => demo.convert(r, i, c)),
    queryPddAuthority: query,
  };
  const get = vi.fn<PddQueryBindingsOptions['registry']['get']>(() => adapter);
  const logger = { warn: vi.fn() };
  const config = { configValue: vi.fn(async () => null) };
  const pids = { getActivePid };
  const options: PddQueryBindingsOptions = {
    db,
    clock,
    callerContext: { current },
    logger,
    config,
    pids,
    appEnv: 'test',
    attrCodes: { attrCode },
    registry: { get },
    reads: createUnionAuthReads({ db, config, pids, appEnv: 'test' }),
    idempotency: createIdempotency({ db, clock, logger }),
    exchanger: { exchange: vi.fn(async () => ({ kind: 'credential_invalid' as const })) },
  };
  const traceId = randomUUID();
  // Include synchronous factory errors in the value: skeleton failures are assertion failures.
  const list = () => outcome(() => createUnionBindingsWithPddQuery(options).list({ traceId }));
  return {
    ...s,
    bindingId,
    clock,
    current,
    attrCode,
    getActivePid,
    query,
    adapter,
    get,
    logger,
    options,
    traceId,
    list,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function listed(value: unknown, pdd: string, taobao = 'unbound') {
  expect(value).toMatchObject({ status: 200, envelope: { code: 0 } });
  const envelope = (value as { envelope: { data: unknown } }).envelope;
  await validate(envelope, 'UnionBindingsResponse');
  expect(envelope.data).toEqual({
    items: [
      { platform: 'taobao', status: taobao },
      { platform: 'pdd', status: pdd },
    ],
  });
}

export async function snapshot(f: Fixture) {
  return {
    bindings: await f.bindings(),
    conflicts: await conflicts(f.db, f.appId),
    sessions: await f.sessions(),
    logs: await f.db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

export async function noSideEffects(f: Fixture) {
  expect(await f.sessions()).toEqual([]);
  expect(
    await f.db.selectFrom('link_logs').selectAll().where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
  expect(f.adapter.convert).not.toHaveBeenCalled();
  expect(f.options.exchanger.exchange).not.toHaveBeenCalled();
}
