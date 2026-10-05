// Rule tests of the DEFAULT-partition alert with quietDefaultTables against a real PostgreSQL
// (task B1-01n; contract addendum in section 5 of apps/api/src/modules/platform/maintenance/worker.ts
// to sections B, C.5 and E of ./index.ts, and section 2 there: createWorkerMaintenance). Basis:
// ADR-0001 §4.2 第 4 项 (每张分区表设 DEFAULT 分区兜底，其中有数据即告警; 按日的表预建未来 14 天 — the
// day-partition maintenance of link_logs is a later task), 第 5 项 (link_logs 按日). link_logs rows
// all sit in its DEFAULT partition until then; the worker reports them at info instead of warn,
// every other table keeps the warn alert. One clone of the migrated template per test; the module
// connects as couli_maint, rows are written as couli_app. Top-level it() only (规划/11 §4.3).
// B1-01w (worker 契约 8, written in ./worker-day-partitions.int.test.ts): the worker's instance no
// longer passes quietDefaultTables and turns day partitions on, so the last test now expects the
// warn alert for link_logs too and the 15 day partitions in the report; the option itself (first
// test) is unchanged.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type {
  MaintenanceReport,
  PartitionMaintenance,
  PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import {
  countingClock,
  createOrStub,
  done,
  line,
  memoryLogger,
  monthRange,
  names,
  reduceLine,
} from './kit.ts';

async function withWorld(
  scenario: (maint: Kysely<DB>, app: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database: TestDatabase = await createTestDatabase();
  const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
  const app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  try {
    await scenario(maint, app);
  } finally {
    await Promise.all([maint, app].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
}

let seq = 0;
/** One event_log row of a long-past month (it lands in event_log_default). */
async function insertOldEvent(app: Kysely<DB>): Promise<string> {
  seq += 1;
  const id = `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
  const result = await sql<{ part: string }>`
    INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
    VALUES ('couli', ${id}::uuid, 'user.updated', '{"order_id":"q"}'::jsonb,
            '2020-03-01T00:00:00Z'::timestamptz)
    RETURNING tableoid::regclass::text AS part
  `.execute(app);
  return result.rows[0]?.part ?? '';
}

/** `count` link_logs rows (no day partition exists: they land in link_logs_default). */
async function insertLinkLogs(app: Kysely<DB>, count: number): Promise<string[]> {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await sql<{ part: string }>`
      INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, created_at)
      VALUES ('couli', 'convert', 0, 'item-13912345678', '2026-11-19T10:00:00Z')
      RETURNING tableoid::regclass::text AS part
    `.execute(app);
    parts.push(result.rows[0]?.part ?? '');
  }
  return parts;
}

async function report(run: Promise<MaintenanceReport>): Promise<unknown> {
  try {
    return { ...(await run) };
  } catch (error) {
    return { error: String(error) };
  }
}

const NOW = '2026-11-20T03:04:05Z';
const MONTHS = monthRange('2026-11', '2027-02');
const ENSURED = [...names('event_log', MONTHS), ...names('orders', MONTHS)];
/** The worker's instance (day partitions on, B1-01w) at NOW: link_logs 2026-11-20 … 2026-12-04 (+08:00). */
const WORKER_ENSURED = [
  ...ENSURED,
  ...Array.from({ length: 15 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 10, 20 + i)).toISOString().slice(0, 10);
    return `link_logs_p${day.replaceAll('-', '')}`;
  }),
];
/** Both DEFAULT partitions hold rows: event_log 1, link_logs 2 (ordered by table, as A2 returns). */
const DEFAULT_ROWS = [
  { table: 'event_log', partition: 'event_log_default', rows: 1 },
  { table: 'link_logs', partition: 'link_logs_default', rows: 2 },
];
const WARN_EVENT_LOG = line('warn', 'partition_default_has_rows', DEFAULT_ROWS[0] ?? {});
const WARN_LINK_LOGS = line('warn', 'partition_default_has_rows', DEFAULT_ROWS[1] ?? {});
const INFO_EVENT_LOG = line('info', 'partition_default_rows_expected', DEFAULT_ROWS[0] ?? {});
const INFO_LINK_LOGS = line('info', 'partition_default_rows_expected', DEFAULT_ROWS[1] ?? {});

/** One run of a fresh instance with `extra` options; its report and reduced log lines. */
async function runWith(
  maint: Kysely<DB>,
  extra: Record<string, unknown>,
  build: (options: PartitionMaintenanceOptions) => PartitionMaintenance = createOrStub,
  afterCreate: () => void = () => undefined,
): Promise<{ report: unknown; lines: unknown[] }> {
  const { logger, lines } = memoryLogger();
  let instance: PartitionMaintenance;
  try {
    instance = build({
      db: maint,
      logger,
      clock: countingClock(NOW),
      ...extra,
    } as PartitionMaintenanceOptions);
  } catch (error) {
    return { report: { error: String(error) }, lines: [] };
  }
  afterCreate();
  return { report: await report(instance.runOnce()), lines: lines.map(reduceLine) };
}

it('[ADR-0001 §4.2 #4 DEFAULT 分区有数据即告警; maintenance 契约补充（worker 契约 5）] quietDefaultTables 列入的表：DEFAULT 有行时报告照旧（defaultRows 含它、行数确切），日志换成一行 info partition_default_rows_expected（表、分区、行数，位置同原告警行）；没列入的表照旧 warn；[] 与不给时完全是现行为；三张都列入时没有 warn；给定的数组创建后再改不影响；行内容不进日志', async () => {
  await withWorld(async (maint, app) => {
    expect(await insertOldEvent(app)).toBe('app.event_log_default');
    expect(await insertLinkLogs(app, 2)).toEqual(Array(2).fill('app.link_logs_default'));
    const expectedReport = { ensured: ENSURED, dropped: [], defaultRows: DEFAULT_ROWS, failed: 0 };
    const mutable = ['link_logs'];
    const seen = {
      none: await runWith(maint, {}),
      empty: await runWith(maint, { quietDefaultTables: [] }),
      linkLogs: await runWith(maint, { quietDefaultTables: ['link_logs'] }),
      eventLog: await runWith(maint, { quietDefaultTables: Object.freeze(['event_log']) }),
      all: await runWith(maint, { quietDefaultTables: ['orders', 'link_logs', 'event_log'] }),
      unrelated: await runWith(maint, { quietDefaultTables: ['orders', 'events'] }),
      mutatedAfter: await runWith(maint, { quietDefaultTables: mutable }, createOrStub, () => {
        mutable.push('event_log');
        mutable.splice(0, 1);
      }),
    };
    const warnBoth = [WARN_EVENT_LOG, WARN_LINK_LOGS, done(8, 0, 0)];
    expect(seen).toEqual({
      none: { report: expectedReport, lines: warnBoth },
      empty: { report: expectedReport, lines: warnBoth },
      linkLogs: { report: expectedReport, lines: [WARN_EVENT_LOG, INFO_LINK_LOGS, done(8, 0, 0)] },
      eventLog: { report: expectedReport, lines: [INFO_EVENT_LOG, WARN_LINK_LOGS, done(8, 0, 0)] },
      all: { report: expectedReport, lines: [INFO_EVENT_LOG, INFO_LINK_LOGS, done(8, 0, 0)] },
      unrelated: { report: expectedReport, lines: warnBoth },
      mutatedAfter: {
        report: expectedReport,
        lines: [WARN_EVENT_LOG, INFO_LINK_LOGS, done(8, 0, 0)],
      },
    });
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 分区有数据即告警、#5; worker 契约 2、8（B1-01w）] worker 接线用的 createWorkerMaintenance：link_logs_default 有 3 行时告警一行 warn partition_default_has_rows（不再降为 info）；event_log_default 的行同样 warn；报告含两张表与 15 个日分区；行内容不进日志', async () => {
  await withWorld(async (maint, app) => {
    expect(await insertLinkLogs(app, 3)).toEqual(Array(3).fill('app.link_logs_default'));
    const onlyLinkLogs = await runWith(maint, {}, createWorkerMaintenance);
    expect(await insertOldEvent(app)).toBe('app.event_log_default');
    const both = await runWith(maint, {}, createWorkerMaintenance);
    const linkRows = { table: 'link_logs', partition: 'link_logs_default', rows: 3 };
    const eventRows = { table: 'event_log', partition: 'event_log_default', rows: 1 };
    expect({ onlyLinkLogs, both }).toEqual({
      onlyLinkLogs: {
        report: { ensured: WORKER_ENSURED, dropped: [], defaultRows: [linkRows], failed: 0 },
        lines: [line('warn', 'partition_default_has_rows', linkRows), done(23, 0, 0)],
      },
      both: {
        report: {
          ensured: WORKER_ENSURED,
          dropped: [],
          defaultRows: [eventRows, linkRows],
          failed: 0,
        },
        lines: [
          line('warn', 'partition_default_has_rows', eventRows),
          line('warn', 'partition_default_has_rows', linkRows),
          done(23, 0, 0),
        ],
      },
    });
    expect(JSON.stringify([onlyLinkLogs.lines, both.lines])).not.toMatch(/13912345678|item-/);
  });
});
