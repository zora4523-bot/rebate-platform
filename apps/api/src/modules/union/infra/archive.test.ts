import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { UnionError } from '../domain/types.ts';
import {
  createArchivingTransport,
  isSensitiveParameter,
  requestSummary,
  responseErrorCode,
} from './archive.ts';
import type { UnionTransportRequest } from './replay.ts';

function fakeDb(fail = false) {
  const statements: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            statements.push(query);
            if (fail) throw new RangeError('fake insert refused');
            return { rows: [] as R[], numAffectedRows: 1n };
          },
          async *streamQuery() {
            throw new Error('not streamed');
          },
        }),
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      }),
    },
  });
  return { db, statements };
}

const base: UnionTransportRequest = {
  platform: 'pdd',
  method: 'POST',
  url: 'https://unit.invalid/api?sign=x1&type=q',
  headers: { 'content-type': 'application/json', authorization: 'hdr-x' },
  body: '{"client_id":"c1","p_id":"p1","nested":{"access_token":"t1","keep":1}}',
  archive: { appId: 'unit-app', kind: 'query' },
};

it('[AC-B1-04p-UNIT#1] 敏感键判定覆盖大小写、下划线、连字符与 secret/token 后缀', () => {
  for (const name of ['appKey', 'CLIENT-ID', 'Session_Key', 'x_secret', 'myToken', 'SIGN']) {
    expect(isSensitiveParameter(name)).toBe(true);
  }
  for (const name of ['type', 'p_id', 'goods_sign', 'custom_parameters', 'order_sn']) {
    expect(isSensitiveParameter(name)).toBe(false);
  }
});

it('[AC-B1-04p-UNIT#2] 摘要去掉查询串与敏感键（含嵌套），不含请求头', () => {
  expect(requestSummary(base)).toEqual({
    method: 'POST',
    url: 'https://unit.invalid/api',
    params: { type: 'q', p_id: 'p1', nested: { keep: 1 } },
  });
  expect(requestSummary({ ...base, body: 'not json' })).toEqual({
    method: 'POST',
    url: 'https://unit.invalid/api',
    body_bytes: 8,
  });
});

it('[AC-B1-04p-UNIT#3] 错误码：非 2xx、错误信封、其余为 null', () => {
  const reply = (status: number, body: string) => ({ status, headers: {}, body });
  expect(responseErrorCode(reply(500, ''))).toBe('http_500');
  expect(responseErrorCode(reply(200, '{"error_response":{"error_code":7}}'))).toBe('7');
  expect(responseErrorCode(reply(200, '{"ok":1}'))).toBeNull();
  expect(responseErrorCode(reply(200, 'x'))).toBeNull();
});

it('[AC-B1-04p-UNIT#4] 成功调用插入一行后返回原响应，延迟取 Clock 差', async () => {
  const { db, statements } = fakeDb();
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const reply = { status: 200, headers: {}, body: 'raw' };
  const wrapped = createArchivingTransport(
    async () => {
      clock.advanceMs(5);
      return reply;
    },
    { db, clock, logger },
  );
  expect(await wrapped(base)).toBe(reply);
  expect(statements).toHaveLength(1);
  expect(statements[0]!.sql).toMatch(/^insert into "app"\."union_raw_payloads"/);
  const parameters = statements[0]!.parameters;
  expect(parameters).toContain('unit-app');
  expect(parameters).toContain(5);
  const payload = parameters.find((value) => Buffer.isBuffer(value)) as Buffer;
  expect(gunzipSync(payload).toString()).toBe('raw');
  expect(JSON.stringify(parameters)).not.toMatch(/hdr-x|"c1"|t1|x1/);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B1-04p-UNIT#5] 插入失败时原错误照抛并记 error；无上下文只 warn 不插入', async () => {
  const { db, statements } = fakeDb(true);
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const logger = { warn: vi.fn(), error: vi.fn() };
  const failure = new UnionError('upstream_unavailable', 'unit failure', 'pdd');
  const wrapped = createArchivingTransport(
    async () => {
      throw failure;
    },
    { db, clock, logger },
  );
  await expect(wrapped(base)).rejects.toBe(failure);
  expect(logger.error).toHaveBeenCalledWith(
    {
      event: 'union.raw_payload.archive_failed',
      platform: 'pdd',
      kind: 'query',
      error_name: 'RangeError',
    },
    expect.any(String),
  );
  const { archive: omitted, ...plain } = base;
  void omitted;
  await expect(wrapped(plain)).rejects.toBe(failure);
  expect(statements).toHaveLength(1);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ event: 'union.raw_payload.no_context' });
});
