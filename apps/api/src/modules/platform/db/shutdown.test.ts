import type { EventEmitter } from 'node:events';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';

interface FakeClient extends EventEmitter {
  connection: { stream: { destroy: ReturnType<typeof vi.fn> } };
  end: ReturnType<typeof vi.fn>;
}

const driver = vi.hoisted(() => ({
  hang: 'none' as 'connect' | 'initialize' | 'query' | 'none',
  clients: [] as FakeClient[],
}));

// Use the real pg Pool and Kysely, replacing only the client transport. Graceful end
// deliberately never completes and no 'end' event is emitted, like an unresponsive peer.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{
    default: { Client: new (config?: unknown) => { connectionParameters: unknown } };
  }>();
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    connectionParameters: unknown;

    constructor(config?: unknown) {
      super();
      this.connectionParameters = new actual.default.Client(config).connectionParameters;
    }

    _queryable = true;
    destroyed = false;
    rejectQuery?: (error: Error) => void;
    connection = {
      stream: {
        destroy: vi.fn(() => {
          this.destroyed = true;
          this.rejectQuery?.(new Error('Connection terminated'));
        }),
      },
    };
    end = vi.fn(() => new Promise<void>(() => {}));

    connect(callback: (error?: Error) => void): void {
      driver.clients.push(this);
      if (driver.hang !== 'connect') callback();
    }

    query(text: string): Promise<unknown> {
      if (this.destroyed) return Promise.reject(new Error('Connection terminated'));
      const initializing = text.includes('set_config');
      if (
        (initializing && driver.hang === 'initialize') ||
        (!initializing && driver.hang === 'query')
      ) {
        return new Promise((_resolve, reject) => {
          this.rejectQuery = reject;
        });
      }
      return Promise.resolve({ command: 'SELECT', rows: [{ value: 1 }], rowCount: 1 });
    }
  }
  return { ...actual, default: { ...actual.default, Client } };
});

beforeEach(() => {
  vi.useFakeTimers();
  driver.clients = [];
  driver.hang = 'none';
});

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  const logger = createRootLogger({ entry: 'payout', appEnv: 'test', level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const error = vi.spyOn(logger, 'error');
  const handles = createDbHandles(
    loadConnectionConfig('payout', { DATABASE_URL: 'postgres://couli_payout@127.0.0.1:1/couli' }),
    { logger, closeTimeoutMs: 100 },
  );
  return { handles, warn, error };
}

it.each(['connect', 'initialize', 'query', 'none'] as const)(
  '[AC-B1-01f#5] %s 阶段对端不关闭：超时销毁套接字，不等 end，busy 只算已交付的连接',
  async (hang) => {
    driver.hang = hang;
    const { handles, warn, error } = fixture();
    const query = sql`SELECT 1`.execute(handles.db).catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.clients).toHaveLength(1);
    const client = driver.clients[0]!;
    if (hang === 'none') await query; // Already returned to the idle pool.

    let closed = false;
    const closing = handles.close();
    void closing.then(() => {
      closed = true;
    });
    expect(handles.close()).toBe(closing);
    if (hang === 'connect' || hang === 'initialize') {
      expect(await query).toMatchObject({ name: 'DbError', code: 'closed' });
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(closed).toBe(false);
    expect(client.connection.stream.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);
    expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1);
    await expect(closing).resolves.toBeUndefined();
    if (hang === 'query') {
      expect(await query).toMatchObject({ message: 'Connection terminated' });
      expect(warn.mock.calls).toEqual([[{ pool: 'db', busy: 1 }, 'db_close_timeout']]);
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    expect(error).not.toHaveBeenCalled();
    await expect(sql`SELECT 2`.execute(handles.db)).rejects.toMatchObject({ code: 'closed' });
    await handles.close();
    expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-01f#6] 事务在两条查询间等待业务代码：超时关闭不等回调归还连接', async () => {
  const { handles, warn, error } = fixture();
  const resume = Promise.withResolvers<void>();
  let entered = false;
  const transaction = handles.db
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT 1`.execute(trx);
      entered = true;
      await resume.promise;
    })
    .catch((failure: unknown) => failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(entered).toBe(true);
  let closed = false;
  const closing = handles.close();
  void closing.then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(closed).toBe(true);
  expect(driver.clients[0]!.connection.stream.destroy).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls).toEqual([[{ pool: 'db', busy: 1 }, 'db_close_timeout']]);
  expect(error).not.toHaveBeenCalled();
  resume.resolve();
  expect(await transaction).toMatchObject({ message: 'Connection terminated' });
  await expect(closing).resolves.toBeUndefined();
  expect(driver.clients[0]!.end).toHaveBeenCalledTimes(1);
});
