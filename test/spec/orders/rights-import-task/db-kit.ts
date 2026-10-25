// 连库的夹具；不引 @couli/db/testing（testcontainers-only-in-int-tests），数据库生命周期只在
// *.int.test.ts 管理，由它们传入真实的 TestDatabase。导入存储用平台的 test 实现，队列用 kit.ts 的
// fakeQueue（走平台 validateSend），逐行处理器与表头模板是合成的（B1-09h / B1-09k 与 K-3 之前）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import {
  createRightsImport,
  getRightsImport,
  listRightsImports,
  type RightsImportActor,
  type RightsImportCommand,
  type RightsImportDeps,
} from '../../../../apps/api/src/modules/orders/application/rights-imports.ts';
import type { RightsImportKind } from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';
import {
  handleRightsImport,
  type RightsImportJobDeps,
} from '../../../../apps/api/src/modules/orders/jobs/rights-import.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createImportStore,
  type ImportPutInput,
  type ImportStore,
} from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  NOW,
  fakeProcessors,
  fakeQueue,
  received,
  sheet,
  templates,
  upload,
  type Sent,
} from './kit.ts';

export const IP = '192.0.2.47';
export const ADMIN_NAME = '测试客服';

/** The part of @couli/db/testing's TestDatabase this kit uses. */
export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

export async function open(database: TestDatabaseUrls) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  return {
    db,
    async close() {
      await destroyDb(db);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export type ImportRow = Selectable<DB['rights_imports']>;

export const newAppId = () => `ri_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

export async function fixture(
  h: Harness,
  options: { kinds?: readonly RightsImportKind[]; appId?: string } = {},
) {
  const { db } = h;
  const appId = options.appId ?? newAppId();
  const clock = new FixedClock(NOW);

  async function admin(patch: Partial<Insertable<DB['admin_users']>> = {}) {
    const id = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id,
        app_id: appId,
        login_name: `ri_${id.replaceAll('-', '')}`,
        password_hash: 'synthetic-unused',
        is_super: false,
        status: 'active',
        display_name: ADMIN_NAME,
        created_at: clock.now(),
        updated_at: clock.now(),
        ...patch,
      })
      .execute();
    return id;
  }
  async function account(platform = 'taobao', app = appId) {
    const id = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: app,
        platform,
        account_name: `synthetic-${id}`,
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    return id;
  }

  const adminId = await admin();
  const accountId = await account();
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', entry: 'worker', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  const sent = fakeQueue();
  const puts: ImportPutInput[] = [];
  const registry = templates();
  const rows = fakeProcessors(options.kinds);
  const actor: RightsImportActor = { appId, adminId, ip: IP };

  // Built inside the test (never in a hook): the platform's test implementation of the port.
  const memory = createImportStore({ appEnv: 'test', logger });
  const store: ImportStore = {
    async put(input) {
      puts.push({ ...input, bytes: new Uint8Array(input.bytes) });
      return memory.put(input);
    },
    get: (key) => memory.get(key),
    delete: (key) => memory.delete(key),
  };
  const deps: RightsImportDeps = {
    db,
    clock,
    store,
    queue: sent.queue,
    auditOn: (trx) => createAuditWriter({ db: trx, clock }),
    logger,
  };
  const jobDeps: RightsImportJobDeps = {
    db,
    clock,
    store,
    templates: registry,
    processors: rows.processors,
    logger,
  };

  async function create(command: RightsImportCommand = {}, who: RightsImportActor = actor) {
    return createRightsImport(deps, who, {
      kind: 'rights',
      platform: 'taobao',
      file: upload(sheet(['succeeded'])),
      ...command,
    });
  }

  /** An accepted upload: its import_id and the one job sent for it. */
  async function accepted(command: RightsImportCommand = {}, who: RightsImportActor = actor) {
    const result = await create(command, who);
    expect(result).toMatchObject({ code: 0, data: { status: 'queued' } });
    const importId = (result.data as { import_id: string }).import_id;
    const jobs = sent.sent.filter((s) => s.payload['import_id'] === importId);
    expect(jobs, 'one job for the new task').toHaveLength(1);
    return { importId, send: jobs[0]! };
  }

  async function run(send: Sent, patch: Partial<RightsImportJobDeps> = {}) {
    await handleRightsImport(received(send), { ...jobDeps, ...patch });
  }

  async function task(importId: string) {
    return db
      .selectFrom('rights_imports')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', importId)
      .executeTakeFirst();
  }

  async function failures(importId: string) {
    return db
      .selectFrom('rights_import_failures')
      .select(['row_no', 'reason'])
      .where('app_id', '=', appId)
      .where('import_id', '=', importId)
      .orderBy('row_no')
      .execute();
  }

  const state = async () => ({
    imports: await db
      .selectFrom('rights_imports')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    failures: await db
      .selectFrom('rights_import_failures')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('import_id')
      .orderBy('row_no')
      .execute(),
    audits: await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sent: sent.sent.length,
    puts: puts.length,
  });

  /** A task row inserted directly (list / detail), ended rows with finished_at. */
  async function seed(patch: Partial<Insertable<DB['rights_imports']>> = {}) {
    const id = patch.id ?? randomUUID();
    const status = patch.status ?? 'done';
    const row = {
      id,
      app_id: appId,
      kind: 'rights',
      platform: 'taobao',
      union_account_id: null,
      time_basis: null,
      from: null,
      to: null,
      file_path: `${appId}/${id}.xlsx`,
      status,
      total_rows: 0,
      succeeded_rows: 0,
      failed_rows: 0,
      skipped_rows: 0,
      duplicate_rows: 0,
      created_by: adminId,
      created_at: clock.now(),
      finished_at: status === 'done' || status === 'failed' ? clock.now() : null,
      ...patch,
    } satisfies Insertable<DB['rights_imports']>;
    await db.insertInto('rights_imports').values(row).execute();
    return row;
  }

  async function seedFailures(importId: string, rows: readonly [number, string][], app = appId) {
    await db
      .insertInto('rights_import_failures')
      .values(
        rows.map(([row_no, reason]) => ({ app_id: app, import_id: importId, row_no, reason })),
      )
      .execute();
  }

  const list = (query = { page: 1, page_size: 20 }, app = appId) =>
    listRightsImports({ db }, app, query);
  const detail = (importId: string, app = appId) => getRightsImport({ db }, app, importId);

  return {
    db,
    appId,
    clock,
    adminId,
    accountId,
    actor,
    admin,
    account,
    logger,
    lines,
    queue: sent,
    puts,
    memory,
    store,
    registry,
    rows,
    deps,
    jobDeps,
    create,
    accepted,
    run,
    task,
    failures,
    state,
    seed,
    seedFailures,
    list,
    detail,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
