import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

it.each(['RESET ALL', 'DISCARD ALL', 'RESET default_transaction_read_only'])(
  '[AC-B1-01f#7] dbRead 执行 %s 后及再次借用时仍只读，保留 URL 的其他启动参数',
  async (reset) => {
    // A writable business role proves the startup default, independently of role grants.
    const url = new URL(database.urlFor('couli_app'));
    url.searchParams.set(
      'options',
      '-c statement_timeout=12345 -c default_transaction_read_only=off',
    );
    const config = loadConnectionConfig('admin', {
      DATABASE_URL: database.urlFor('couli_app'),
      DATABASE_READ_URL: url.href,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });
    const handles = createDbHandles(
      { ...config, dbRead: { ...config.dbRead!, max: 1 } },
      { logger: createRootLogger({ entry: 'admin', appEnv: 'test', level: 'silent' }) },
    );
    const dbRead = handles.dbRead!;
    const settings = sql<{ pid: number; ro: string; timeout: string }>`
      SELECT pg_backend_pid() AS pid, current_setting('default_transaction_read_only') AS ro,
             current_setting('statement_timeout') AS timeout
    `;
    const write = sql`INSERT INTO app.processed_events (consumer, event_id)
      VALUES ('readonly-reset', ${randomUUID()})`;
    try {
      const before = (await settings.execute(dbRead)).rows[0]!;
      expect(before).toMatchObject({ ro: 'on', timeout: '12345ms' });
      await dbRead.connection().execute(async (connection) => {
        await sql.raw(reset).execute(connection);
        expect((await settings.execute(connection)).rows[0]).toEqual(before);
        await expect(write.execute(connection)).rejects.toMatchObject({ code: '25006' });
      });
      // Pool size one and the backend PID assertion ensure this reuses the reset session.
      expect((await settings.execute(dbRead)).rows[0]).toEqual(before);
      await expect(write.execute(dbRead)).rejects.toMatchObject({ code: '25006' });
      await expect(
        dbRead.transaction().execute(async (trx) => write.execute(trx)),
      ).rejects.toMatchObject({ code: '25006' });
      expect((await write.execute(handles.db)).numAffectedRows).toBe(1n);
    } finally {
      await handles.close();
    }
  },
);
