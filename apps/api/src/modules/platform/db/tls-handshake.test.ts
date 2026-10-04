import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { createDb } from '@couli/db';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';

type PoolConfig = Parameters<NonNullable<Parameters<typeof createDb>[0]['poolFactory']>>[0];
const driver = vi.hoisted(() => ({ streams: [] as RefuseSslStream[] }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<{
    default: { Client: new (config: PoolConfig & { stream: () => Duplex }) => object };
  }>();
  class Client extends actual.default.Client {
    constructor(config: PoolConfig) {
      const stream = new RefuseSslStream();
      super({ ...config, stream: () => stream });
      driver.streams.push(stream);
    }
  }
  return { ...actual, default: { ...actual.default, Client } };
});

// In-memory transport exercises pg's real SSL negotiation, with no socket or listener.
class RefuseSslStream extends Duplex {
  writes: Buffer[] = [];
  connect(): void {
    queueMicrotask(() => this.emit('connect'));
  }
  setNoDelay(): void {}
  setKeepAlive(): void {}
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.writes.push(Buffer.from(chunk));
    callback();
    queueMicrotask(() => this.push(Buffer.from('N')));
  }
}

it.each(['require', 'verify-ca', 'verify-full'])(
  '[AC-B1-01f#15] %s 遇到不支持 SSL 的服务端时拒绝连接，不发明文启动或口令',
  async (mode) => {
    driver.streams = [];
    const root = encodeURIComponent(fileURLToPath(import.meta.url));
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: `postgres://couli_app:p%25word@db.example/couli?sslmode=${mode}${mode === 'verify-ca' ? `&sslrootcert=${root}` : ''}`,
      DATABASE_READ_URL: `postgres://couli_readonly:p%25word@db.example/couli?sslmode=${mode}${mode === 'verify-ca' ? `&sslrootcert=${root}` : ''}`,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const handles = createDbHandles(config, {
      logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }),
    });
    try {
      for (const db of [handles.db, handles.dbRead!]) {
        await expect(sql`SELECT 1`.execute(db)).rejects.toThrow(
          'The server does not support SSL connections',
        );
      }
      expect(driver.streams).toHaveLength(2);
      for (const stream of driver.streams) {
        expect(stream.writes).toEqual([Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])]);
      }
    } finally {
      for (const stream of driver.streams) stream.destroy();
      await handles.close();
    }
  },
);
