import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { harness, outcome, request, response, rows } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly') });
});
afterAll(async () => {
  if (readonlyDb) await destroyDb(readonlyDb);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

it.each(['success', 'http', 'throw'] as const)(
  '[AC-B1-04p-FAIL#1] 数据库拒绝 INSERT 时 %s 原结果不变，error 日志只含事件、platform、kind、错误名',
  async (mode) => {
    const h = harness(readonlyDb);
    const reply = { ...response('fake-response-private!'), status: mode === 'http' ? 503 : 200 };
    const failure = new UnionError('upstream_unavailable', 'fake-error-private!', 'pdd');
    const inner = vi.fn<UnionTransport>(async () => {
      if (mode === 'throw') throw failure;
      return reply;
    });
    const wrapped = createArchivingTransport(inner, h);
    const input = request(h.appId, { body: '{"order_sn":"fake-request-private!"}' });
    expect(await outcome(() => wrapped(input))).toBe(mode === 'throw' ? failure : reply);
    expect(inner).toHaveBeenCalledExactlyOnceWith(input);
    expect(await rows(db, h.appId)).toEqual([]);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const fields = h.logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      event: 'union.raw_payload.archive_failed',
      platform: 'pdd',
      kind: 'query',
    });
    // Field spelling for the error name is intentionally unconstrained; no stack/message/cause.
    const extra = Object.entries(fields).filter(
      ([name]) => !['event', 'platform', 'kind'].includes(name),
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.[1]).toBeTypeOf('string');
    expect(String(extra[0]?.[1]).toLowerCase()).toBe('error');
    const text = JSON.stringify(h.logger.error.mock.calls);
    for (const marker of [
      'fake-request-private!',
      'fake-response-private!',
      'fake-error-private!',
      'permission denied',
      'synthetic.invalid',
      h.appId,
    ]) {
      expect(text).not.toContain(marker);
    }
  },
);

it.each(['success', 'throw'] as const)(
  '[AC-B1-04p-CONTEXT#1] 缺 archive 上下文时 %s 不写行，原样转发并 warn 一次',
  async (mode) => {
    const h = harness(db);
    const reply = response();
    const failure = new UnionError('upstream_unavailable', 'fake-failure!', 'pdd');
    const inner = vi.fn<UnionTransport>(async () => {
      if (mode === 'throw') throw failure;
      return reply;
    });
    const wrapped = createArchivingTransport(inner, h);
    const { archive: omitted, ...input } = request(h.appId);
    void omitted;
    const before = await db.selectFrom('union_raw_payloads').select('id').execute();
    expect(await outcome(() => wrapped(input))).toBe(mode === 'throw' ? failure : reply);
    expect(inner).toHaveBeenCalledExactlyOnceWith(input);
    expect(await db.selectFrom('union_raw_payloads').select('id').execute()).toEqual(before);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]?.[0]).toMatchObject({
      event: 'union.raw_payload.no_context',
    });
    expect(h.logger.error).not.toHaveBeenCalled();
  },
);
