import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

// 第四次测试裁定：迁移由实现提供；测试只集中声明表、列与状态的约定。
export const ATTEMPT_TABLE = 'app.sms_send_attempts';
export const ATTEMPT_COLUMNS = {
  app: 'app_id',
  id: 'attempt_id',
  ip: 'ip_hmac',
  phone: 'phone_hmac',
  created: 'created_at',
  updated: 'updated_at',
  status: 'status',
} as const;
export const SEND_TIMEOUT_MS = 10_000;
export const EXTENDED_WINDOW_MS = 3_610_000;
// 与 0052 迁移一致；结果回写仅允许 pending → 三种终态，终态不可再迁移。
export const ATTEMPT_STATUSES = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'failed',
  unknown: 'unknown',
} as const;
export type Attempt = {
  app_id: string;
  attempt_id: string;
  ip_hmac: string;
  phone_hmac: string;
  created_at: Date;
  status: (typeof ATTEMPT_STATUSES)[keyof typeof ATTEMPT_STATUSES];
};

export async function assertAttemptTable(db: Kysely<DB>) {
  const result = await sql<{ present: boolean }>`select to_regclass(${ATTEMPT_TABLE}) is not null
    as present`.execute(db);
  expect(result.rows[0]?.present, 'PG authoritative SMS attempt migration').toBe(true);
}

export async function readAttempts(db: Kysely<DB>, appId: string): Promise<Attempt[]> {
  return (
    await sql<Attempt>`select ${sql.join(Object.values(ATTEMPT_COLUMNS).map((c) => sql.ref(c)))}
      from ${sql.table(ATTEMPT_TABLE)} where ${sql.ref(ATTEMPT_COLUMNS.app)} = ${appId}
      order by ${sql.ref(ATTEMPT_COLUMNS.created)}, ${sql.ref(ATTEMPT_COLUMNS.id)}`.execute(db)
  ).rows;
}

export async function seedAccepted(
  db: Kysely<DB>,
  appId: string,
  ipHmac: string,
  phoneHmac: string,
  instants: string[],
) {
  await assertAttemptTable(db);
  for (const instant of instants) {
    const created = new Date(instant);
    await sql`insert into ${sql.table(ATTEMPT_TABLE)}
      (${sql.join(Object.values(ATTEMPT_COLUMNS).map((c) => sql.ref(c)))})
      values (${appId}, ${randomUUID()}, ${ipHmac}, ${phoneHmac},
        ${created}, ${created}, ${'accepted'})`.execute(db);
  }
}
