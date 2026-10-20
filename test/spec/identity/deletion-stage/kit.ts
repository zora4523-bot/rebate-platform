// B1-15c §9.3 is the scope: two-source stage reads and the three invitation consumers.
// Only *.int.test.ts acquires databases. These are synthetic fixtures, not lifecycle commands.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

type ReaderModule =
  typeof import('../../../../apps/api/src/modules/identity/ports/deletion-stage.ts');
type FundsModule =
  typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts');
export type Executor = Kysely<DB> | Transaction<DB>;
export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';

// Runtime public export, with Nest decorators kept out of the erasable-only test project.
export async function identity(): Promise<ReaderModule & FundsModule> {
  return import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  ) as Promise<ReaderModule & FundsModule>;
}

export async function user(db: Executor, appId: string, status = 'normal') {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'synthetic-private-name',
      avatar: 'https://example.invalid/private-avatar',
      phone_hmac: `synthetic-private-phone-${id}`,
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status,
      register_method: 'sms',
      created_at: new Date('2026-09-01T00:00:00Z'),
      updated_at: new Date('2026-09-01T00:00:00Z'),
    })
    .execute();
  return id;
}

export async function request(
  db: Executor,
  appId: string,
  userId: string,
  status: RequestStatus,
  at = new Date('2026-09-01T00:00:00Z'),
) {
  const id = randomUUID();
  const until = new Date(at.getTime() + 7 * 86_400_000);
  await db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id,
      app_id: appId,
      user_id: userId,
      status,
      apply_at: at,
      cooling_until: until,
      cancelled_at: status === 'cancelled' ? at : null,
      cancel_reason: status === 'cancelled' ? 'user' : null,
      processed_at: status === 'done' ? until : null,
      balance_snapshot_fen: 0n,
      created_at: at,
      updated_at: status === 'done' ? until : at,
    })
    .execute();
  return id;
}

export async function cancel(db: Executor, id: string, at: Date) {
  await db
    .withSchema('app')
    .updateTable('deletion_requests')
    .set({ status: 'cancelled', cancelled_at: at, cancel_reason: 'user', updated_at: at })
    .where('id', '=', id)
    .execute();
}

export function observe(db: Executor) {
  const statements: string[] = [];
  const executor = db.withPlugin({
    transformQuery({ node, queryId }) {
      statements.push(db.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  return { executor, statements };
}
