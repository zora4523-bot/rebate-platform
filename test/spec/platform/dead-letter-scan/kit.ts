import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

// B1-01zzg 编排补充 B：业务队列清单独立于待测目录，防止漏队列时测试空过。
export const BUSINESS_QUEUES = [
  'order-sync',
  'order-rescan',
  'settle',
  'payout',
  'notify',
  'evt.notification-risk-state',
  'evt.notification-appeal-result',
  'pool-refresh',
  'page-schedule',
  'poster',
  'agent-trace',
  'risk-scan',
  'export',
] as const;

export function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'worker', appEnv: 'test', level: 'trace' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines, clock: new FixedClock('2031-04-05T06:07:08.000Z') };
}

/** Deliberately prepare queues independently of the migration/catalog under test. */
export async function prepareQueues(db: Kysely<DB>, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await sql`SELECT pgboss.create_queue(${name}, ${JSON.stringify({
      policy: 'standard',
      retryLimit: 0,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
    })}::jsonb)`.execute(db);
  }
}

export async function insertJob(
  db: Kysely<DB>,
  queue: string,
  data: Record<string, unknown>,
  state = 'created',
): Promise<void> {
  await sql`
    INSERT INTO pgboss.job (name, data, state)
    VALUES (${queue}, ${JSON.stringify(data)}::jsonb, ${state}::pgboss.job_state)
  `.execute(db);
}

export async function jobSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(j) AS row FROM pgboss.job j ORDER BY name, id`.execute(db))
    .rows;
}

export function alerts(lines: readonly Record<string, unknown>[]) {
  return lines
    .filter((line) => line['level'] === 50 && typeof line['queue'] === 'string')
    .map((line) => ({
      queue: line['queue'],
      ...(line['platform'] == null ? {} : { platform: line['platform'] }),
      count: line['count'],
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
