// B1-22r / orchestrator ruling D10-427 ③, SPEC_REF 37808a5; BR-ATTR-08 (active PID by scene,
// never another scene): with several active pdd `query` PIDs of one app (different union accounts),
// readActivePddQueryPid picks the one updated earliest, equal updated_at by id ascending (the
// selection rule does not change; choosing by account waits for FU-PDD-QUERY-ACCT). When there is
// more than one candidate it writes one log line (info or debug) carrying app_id, the chosen
// union_pid's id and union_account_id, and the number of active candidates of the scene; no
// credential or secret. The logger is an optional third parameter (the call site in union.module.ts
// passes it). Real PG (business role); the logger is the platform's pino root logger writing to
// memory.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { readActivePddQueryPid } from '../../../../apps/api/src/modules/union/pids/query-reader.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';

const database = databaseFixture(createTestDatabase);

/** The reader with its optional logger (D10-427 ③). */
const read = readActivePddQueryPid as (
  db: Kysely<DB>,
  appId: string,
  logger?: RootLogger,
) => Promise<string | null>;

const CREATED = '2026-09-01T00:00:00.000Z';
const CONFIRMED = '2026-09-01T01:00:00.000Z';

function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

/** `count` fresh uuids in ascending order (PostgreSQL compares uuid bytes as the hex text). */
const ascendingIds = (count: number) =>
  Array.from({ length: count }, () => randomUUID()).sort((a, b) => (a < b ? -1 : 1));

interface PidSeed {
  readonly id?: string;
  readonly accountId: string;
  readonly updatedAt: string;
  readonly createdAt?: string;
  readonly status?: 'pending' | 'active' | 'retired';
  readonly scene?: 'query' | 'self_buy';
  readonly appId?: string;
}

async function scenario(db: Kysely<DB>) {
  const appId = `pdd_query_pid_${randomUUID().replaceAll('-', '')}`;
  const otherApp = `pdd_query_pid_other_${randomUUID().replaceAll('-', '')}`;
  /** Plaintext stand-ins of every credential the app holds; none may reach a log line. */
  const secrets: string[] = [];

  async function account(app = appId) {
    const id = randomUUID();
    await db
      .insertInto('union_accounts')
      .values({
        id,
        app_id: app,
        platform: 'pdd',
        account_name: `synthetic-pdd-${id}`,
        status: 'active',
        auth_status: 'active',
        created_at: CREATED,
        updated_at: CREATED,
      })
      .execute();
    const access = `fixture-pdd-access-${randomUUID()}`;
    const refresh = `fixture-pdd-refresh-${randomUUID()}`;
    await db
      .insertInto('union_credentials')
      .values({
        id: randomUUID(),
        app_id: app,
        union_account_id: id,
        access_token_cipher: Buffer.from(access),
        refresh_token_cipher: Buffer.from(refresh),
        expires_at: null,
        is_current: true,
        created_at: CREATED,
        updated_at: CREATED,
      })
      .execute();
    secrets.push(access, refresh);
    return id;
  }

  async function pid(seed: PidSeed) {
    const status = seed.status ?? 'active';
    const evidence = status === 'pending' ? null : `union-pids/${randomUUID()}/hjy.png`;
    return db
      .insertInto('union_pids')
      .values({
        id: seed.id ?? randomUUID(),
        app_id: seed.appId ?? appId,
        platform: 'pdd',
        union_account_id: seed.accountId,
        site_id: null,
        pid: `q_${randomUUID().replaceAll('-', '')}`,
        pid_scene: seed.scene ?? 'query',
        status,
        row_version: 1,
        hjy_ignore_confirmed_at: status === 'pending' ? null : CONFIRMED,
        hjy_ignore_evidence_path: evidence,
        created_at: seed.createdAt ?? CREATED,
        updated_at: seed.updatedAt,
      })
      .returning(['id', 'pid', 'union_account_id'])
      .executeTakeFirstOrThrow();
  }

  return { db, appId, otherApp, secrets, account, pid };
}

interface LogEntry {
  readonly level: number;
  readonly app_id?: unknown;
  readonly union_account_id?: unknown;
  readonly [key: string]: unknown;
}

/** The info / debug lines about `appId` written since `from`. */
function selectionLines(lines: readonly string[], appId: string, from = 0): LogEntry[] {
  return lines
    .slice(from)
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => (entry.level === 20 || entry.level === 30) && entry.app_id === appId);
}

/** One selection line naming the chosen row, its account and the candidate count; no secret. */
function expectSelectionLog(
  lines: readonly string[],
  from: number,
  appId: string,
  chosen: { id: string; union_account_id: string },
  candidates: number,
  secrets: readonly string[],
) {
  const entries = selectionLines(lines, appId, from);
  expect(entries, lines.slice(from).join('\n')).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.union_account_id).toBe(chosen.union_account_id);
  const values = Object.values(entry);
  expect(values, 'the chosen union_pid id').toContain(chosen.id);
  expect(values, 'the number of active query candidates').toContain(candidates);
  for (const line of lines.slice(from)) {
    for (const secret of secrets) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain(Buffer.from(secret).toString('hex'));
      expect(line).not.toContain(Buffer.from(secret).toString('base64'));
    }
  }
}

it('[B1-22r][D10-427 ③] 多个账号各有 active 查询位：取 updated_at 最早的一条（与 id 顺序相反也一样），并写一条选取日志（app_id、所选 id 与账号、候选条数），无凭据', async () => {
  const s = await scenario(database());
  const [a, b, c] = [await s.account(), await s.account(), await s.account()];
  const [low, mid, high] = ascendingIds(3);
  // The earliest updated_at has the highest id, so id order alone would pick another row.
  await s.pid({ id: low!, accountId: a, updatedAt: '2026-10-03T00:00:00.000Z' });
  await s.pid({ id: mid!, accountId: b, updatedAt: '2026-10-02T00:00:00.000Z' });
  const winner = await s.pid({ id: high!, accountId: c, updatedAt: '2026-10-01T00:00:00.000Z' });
  // Not candidates: retired, pending, another scene, another app (each updated even earlier).
  const earlier = '2026-09-02T00:00:00.000Z';
  await s.pid({ accountId: await s.account(), updatedAt: earlier, status: 'retired' });
  await s.pid({ accountId: await s.account(), updatedAt: earlier, status: 'pending' });
  await s.pid({ accountId: a, updatedAt: earlier, scene: 'self_buy' });
  await s.pid({ accountId: await s.account(s.otherApp), updatedAt: earlier, appId: s.otherApp });

  const { logger, lines } = memoryLogger();
  expect(await read(s.db, s.appId, logger)).toBe(winner.pid);
  expectSelectionLog(lines, 0, s.appId, winner, 3, s.secrets);
  expect(selectionLines(lines, s.otherApp)).toEqual([]);
});

it('[B1-22r][D10-427 ③] updated_at 相同按 id 升序取（与插入顺序无关），每次调用结果相同、各写一条选取日志，无凭据', async () => {
  const s = await scenario(database());
  const [a, b, c] = [await s.account(), await s.account(), await s.account()];
  const [low, high] = ascendingIds(2);
  const tie = '2026-10-01T00:00:00.000Z';
  // The higher id goes in first, and the later-updated row has the lowest created_at.
  await s.pid({ id: high!, accountId: a, updatedAt: tie });
  const winner = await s.pid({ id: low!, accountId: b, updatedAt: tie });
  await s.pid({
    accountId: c,
    updatedAt: '2026-10-05T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  });

  const { logger, lines } = memoryLogger();
  expect(await read(s.db, s.appId, logger)).toBe(winner.pid);
  expectSelectionLog(lines, 0, s.appId, winner, 3, s.secrets);
  const second = lines.length;
  expect(await read(s.db, s.appId, logger)).toBe(winner.pid);
  expectSelectionLog(lines, second, s.appId, winner, 3, s.secrets);
});

it('[B1-22r][D10-427 ③] 候选条数只数本 app 同场景 active 的查询位：两条 active 加退役、待启用、别的场景时记 2，所选账号写在日志里', async () => {
  const s = await scenario(database());
  const [a, b] = [await s.account(), await s.account()];
  const winner = await s.pid({ accountId: b, updatedAt: '2026-10-01T00:00:00.000Z' });
  await s.pid({ accountId: a, updatedAt: '2026-10-02T00:00:00.000Z' });
  await s.pid({ accountId: a, updatedAt: '2026-09-01T00:00:00.000Z', status: 'retired' });
  await s.pid({ accountId: b, updatedAt: '2026-09-01T00:00:00.000Z', status: 'pending' });
  await s.pid({ accountId: b, updatedAt: '2026-09-01T00:00:00.000Z', scene: 'self_buy' });

  const { logger, lines } = memoryLogger();
  expect(await read(s.db, s.appId, logger)).toBe(winner.pid);
  expectSelectionLog(lines, 0, s.appId, winner, 2, s.secrets);
});
