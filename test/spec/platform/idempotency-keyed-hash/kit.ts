// B1-01zzf 编排裁定 C：只扩展测试侧结构类型，现有实现可加载并以行为断言先红。
// 不替换被测工厂；Kysely 使用内存脚本驱动，SQL 参数就是实际准备写入的指纹。
import { createHash, createHmac } from 'node:crypto';
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createIdempotency,
  type IdempotencyOptions,
  type IdempotentRequest,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';

export type Mode = 'execute' | 'executeInTransaction';
export type DigestRequest = IdempotentRequest & { readonly keyedRequestDigest?: boolean };
export const MODES: readonly Mode[] = ['execute', 'executeInTransaction'];
export const CONTEXT = 'idempotency.request_hash';
export const TRACE = 'b101zzf-request-trace';
export const NOW = '2031-05-06T07:08:09.000Z';
export const BODY = {
  phone: '13800138000',
  name: '测试甲',
  id_no: '11010519491231002X',
  bank_account: '6222020000000000',
  alipay_login: 'sample@example.test',
};
export const JSON_BODY =
  '{"alipay_login":"sample@example.test","bank_account":"6222020000000000","id_no":"11010519491231002X","name":"测试甲","phone":"13800138000"}';
export const RESULT = {
  status: 201,
  envelope: { code: 0, msg: '', data: { accepted: true }, trace_id: 'original-trace' },
};
export const SAVED = { status: RESULT.status, body: JSON.stringify(RESULT.envelope) };

export function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Independent oracle: FieldCrypto blind-index protocol is context + NUL + UTF-8 value. */
export function keyed(text: string, keyByte = 37, context = CONTEXT): string {
  return `hmac1:${createHmac('sha256', Buffer.alloc(32, keyByte))
    .update(Buffer.concat([Buffer.from(context), Buffer.from([0]), Buffer.from(text)]))
    .digest('hex')}`;
}

export function cryptoFixture(keyByte = 37) {
  const blindIndex = vi.fn((value: string, context: string) =>
    createHmac('sha256', Buffer.alloc(32, keyByte))
      .update(context, 'utf8')
      .update(Buffer.from([0]))
      .update(value, 'utf8')
      .digest('hex'),
  );
  function unused(): never {
    throw new Error('unexpected encryption operation in digest test');
  }
  const fieldCrypto: FieldCrypto = {
    currentKeyVersion: 1,
    blindIndex,
    encrypt: unused,
    decrypt: unused,
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
  };
  return { fieldCrypto, blindIndex };
}

export function request(mode: Mode, body: unknown = BODY): DigestRequest {
  return {
    appId: 'couli',
    actor: {
      userId: '0199a3b4-5c6d-7e8f-9a0b-000000000001',
      deviceId: null,
      phoneHmac: null,
    },
    method: 'POST',
    path: mode === 'execute' ? '/v1/me/realname' : '/v1/me/phone',
    key: 'b101zzf-request',
    body,
    traceId: TRACE,
    keyedRequestDigest: true,
  };
}

export function completed(hash: string): Record<string, unknown> {
  return {
    id: 1n,
    status: 'completed',
    request_hash: hash,
    response: SAVED,
    created_at: new FixedClock(NOW).now(),
    ownership_created_at: NOW,
  };
}

export function fixture(
  options: {
    fieldCrypto?: FieldCrypto;
    row?: Record<string, unknown>;
    lockHeld?: boolean;
  } = {},
) {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    release: vi.fn(),
    async query(sql: string, parameters: readonly unknown[] = []) {
      statements.push({ sql, parameters });
      let rows: unknown[] = [];
      if (sql.includes('pg_try_advisory_xact_lock')) rows = [{ acquired: !options.lockHeld }];
      else if (sql.includes('current_setting')) rows = [{ value: '0' }];
      else if (sql.startsWith('select') && sql.includes('"idempotency_keys"'))
        rows = options.row === undefined ? [] : [options.row];
      else if (/^(insert|update|delete) /u.test(sql))
        rows = [{ id: 1n, ownership_created_at: NOW }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  const clock = new FixedClock(NOW);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const settings: IdempotencyOptions & { fieldCrypto?: FieldCrypto } = {
    db,
    clock,
    logger,
    ...(options.fieldCrypto === undefined ? {} : { fieldCrypto: options.fieldCrypto }),
  };
  const idem = createIdempotency(settings);
  const writes = () => statements.filter(({ sql }) => /^(insert|update|delete) /u.test(sql));
  function hashWrites(): unknown[] {
    return writes().flatMap(({ sql, parameters }) => {
      if (sql.startsWith('insert')) {
        const match = /\(([^)]+)\) values \((.+)\) on conflict/u.exec(sql);
        const columns = match?.[1]?.split(',').map((column) => column.trim());
        const index = columns?.indexOf('"request_hash"') ?? -1;
        const placeholder = match?.[2]?.split(',')[index]?.trim();
        const position = /^\$(\d+)$/u.exec(placeholder ?? '')?.[1];
        return position === undefined ? [] : [parameters[Number(position) - 1]];
      }
      const position = /"request_hash" = \$(\d+)/u.exec(sql)?.[1];
      return position === undefined ? [] : [parameters[Number(position) - 1]];
    });
  }
  return { db, idem, clock, logger, statements, writes, hashWrites };
}
