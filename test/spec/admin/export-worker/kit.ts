import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { createAuditLogsReader } from '../../../../apps/api/src/modules/admin/application/audit-logs-read.ts';
import { createAdminProfiles } from '../../../../apps/api/src/modules/admin/infra/admin-profiles.ts';
import { createAuditLogStore } from '../../../../apps/api/src/modules/admin/infra/audit-log-store.ts';
import { createAuditLogIdCodec } from '../../../../apps/api/src/modules/admin/infra/audit-log-id.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type {
  ExportUserRow,
  ExportUsersQuery,
} from '../../../../apps/api/src/modules/identity/application/export-users.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { MemoryExportStore } from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type {
  JobPayload,
  JobHandler,
  ReceivedJob,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';

export const START = '2026-10-22T02:00:00.000Z';
export const DAY = 86_400_000;

/** The slice of the shared integration database provisioner this kit uses. */
interface ProvisionedDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/**
 * Uses the shared integration database provisioner (passed in by the *.int.test.ts file, the only
 * place allowed to import it) and the business role only.
 */
export function databaseHarness(provision: () => Promise<ProvisionedDatabase>) {
  let database: ProvisionedDatabase;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await provision();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 }).withSchema('app');
  });
  afterAll(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
  });
  return { db: () => db };
}

export async function seedAdmin(db: Kysely<DB>, appId: string, isSuper = false) {
  return db
    .insertInto('admin_users')
    .values({
      id: randomUUID(),
      app_id: appId,
      login_name: randomUUID(),
      password_hash: 'synthetic-disabled-login',
      is_super: isSuper,
      status: 'active',
      display_name: '演示管理员',
      locked_until: null,
      totp_secret_cipher: null,
      totp_bound_at: null,
      totp_last_step: null,
      verify_phone_cipher: null,
      verify_phone_hmac: null,
      verify_phone_set_at: null,
      created_at: START,
      updated_at: START,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function userRow(index: number): ExportUserRow {
  return {
    user_id: randomUUID(),
    nickname: `演示用户${index}`,
    phone: '138****5678',
    level: 'L1',
    risk_state: 'normal',
    created_at: START,
  };
}

export async function fixture(
  db: Kysely<DB>,
  settings: { maxRows?: number; maxRunning?: number; isSuper?: boolean } = {},
) {
  const queries: string[] = [];
  db = db.withPlugin({
    transformQuery({ node }) {
      queries.push(
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? String(value) : value,
        ),
      );
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const appId = `e_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const admin = await seedAdmin(db, appId, settings.isSuper);
  const clock = new FixedClock(START);
  const logs: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', entry: 'worker', appEnv: 'test' },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
  const store = new MemoryExportStore({
    clock,
    logger,
    baseUrl: 'https://exports.example.invalid',
    signingKey: 'synthetic-export-test-key',
  });
  const put = vi.spyOn(store, 'put');
  const remove = vi.spyOn(store, 'delete');
  const rows = [userRow(1), userRow(2), userRow(3)];
  const page = vi.fn(async (input: ExportUsersQuery) => ({
    items: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
    total: rows.length,
  }));
  const configValue = vi.fn(async (_app: string, key: string) => {
    const value =
      key === 'admin.export.max_rows'
        ? settings.maxRows
        : key === 'admin.export.max_running_per_admin'
          ? settings.maxRunning
          : undefined;
    return value === undefined ? null : { value, version: 1 };
  });
  const profiles = createAdminProfiles({ db });
  const auditLogs = createAuditLogsReader({
    store: createAuditLogStore({ db }),
    profiles,
    ids: () => createAuditLogIdCodec(Buffer.alloc(16, 7)),
    configPermissions: new Map(),
  });
  const auditList = vi.spyOn(auditLogs, 'list');
  const sent: { queue: string; name: string; payload: JobPayload; options: SendOptions }[] = [];
  const send = vi.fn(
    async (queue: string, name: string, payload: JobPayload, options: SendOptions) => {
      sent.push({ queue, name, payload, options });
      return randomUUID();
    },
  );
  const deps = {
    db,
    clock,
    logger,
    store,
    users: { page },
    auditLogs,
    profiles,
    config: { configValue },
    queue: { send },
  };
  // Keep factory construction inside each test: the test phase fails at NotImplemented,
  // never during module loading or a beforeAll hook.
  const worker = async () => {
    // Dynamic import prevents Nest's transitive decorators from being compiled by test's
    // erasable-only project. apps/api's own project checks the implementation and its ports.
    const module = (await import(
      new URL(
        '../../../../apps/api/src/modules/admin/application/export-worker.ts',
        import.meta.url,
      ).href
    )) as {
      createExportWorker(options: typeof deps): {
        handle: JobHandler;
        cancelByCreator(input: { appId: string; adminId: string }): Promise<void>;
      };
    };
    return module.createExportWorker(deps);
  };
  async function task(patch: Partial<Insertable<DB['export_tasks']>> = {}) {
    return db
      .insertInto('export_tasks')
      .values({
        id: randomUUID(),
        app_id: appId,
        public_id: `exp_${randomUUID().replaceAll('-', '')}`,
        created_by: admin.id,
        resource: 'users',
        masked: true,
        filters: {},
        filters_summary: '演示筛选',
        status: 'pending',
        progress: null,
        failure_reason: null,
        file_name: null,
        object_key: null,
        row_count: null,
        generated_at: null,
        expires_at: null,
        created_at: START,
        updated_at: START,
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const read = (id: string) =>
    db.selectFrom('export_tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const job = (taskId: string, name = 'generate', jobApp = appId): ReceivedJob => ({
    id: randomUUID(),
    queue: 'export',
    name,
    payload: { appId: jobApp, taskId },
    attempt: 1,
  });
  async function audit(
    actor: string,
    action: string,
    target: string,
    after: DB['audit_logs']['after'] = null,
  ) {
    await createAuditWriter({ db, clock }).append({
      appId,
      actor,
      action,
      target,
      before: null,
      after,
      ip: null,
    });
  }
  async function audits() {
    return db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }
  return {
    db,
    queries,
    appId,
    admin,
    clock,
    logs,
    store,
    put,
    remove,
    rows,
    page,
    configValue,
    profiles,
    auditLogs,
    auditList,
    sent,
    send,
    deps,
    worker,
    task,
    read,
    job,
    audit,
    audits,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function auditText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? String(item) : item,
  );
}

export async function csv(f: Fixture, taskId: string) {
  const row = await f.read(taskId);
  expect(row.object_key).toBe(`${f.appId}/${row.public_id}.csv`);
  const stored = f.store.get(row.object_key!);
  expect(stored).toBeDefined();
  expect(stored!.contentType).toBe('text/csv');
  expect([...stored!.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return Buffer.from(stored!.bytes).toString('utf8').slice(1);
}

/** Independent RFC 4180 reader: embedded CRLF/quotes must survive round-trip. */
export function parseCsv(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      result.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += char;
    }
  }
  expect(quoted).toBe(false);
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    result.push(row);
  }
  return result;
}

export async function running(db: Kysely<DB>, appId: string, adminId: string) {
  const result = await sql<{ count: bigint }>`select count(*) as count from app.export_tasks
    where app_id = ${appId} and created_by = ${adminId} and status = 'running'`.execute(db);
  return Number(result.rows[0]!.count);
}
