import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export function migration(): string {
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const files = readdirSync(directory).filter((name) =>
    name.endsWith('_ledger-user-accounts-backfill.sql'),
  );
  // Called inside each it, before opening a database: missing SQL is assertion-red.
  expect(files, '迁移文件不存在或不唯一：_ledger-user-accounts-backfill.sql').toHaveLength(1);
  return readFileSync(new URL(files[0]!, directory), 'utf8');
}

export async function replay(db: Kysely<DB>, source: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Execute the entire file, including SET LOCAL, without reconstructing its INSERTs.
    await sql.raw(source).execute(trx);
  });
}

export async function user(
  db: Kysely<DB>,
  appId: string,
  status = 'normal',
  deletedReason: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: 'backfill fixture',
      avatar: '',
      invite_code: id,
      attr_code: id,
      level: 'L1',
      register_method: 'sms',
      status,
      deleted_reason: deletedReason,
      created_at: new Date('2025-01-02T03:04:05.000Z'),
      updated_at: new Date('2025-01-02T03:04:05.000Z'),
    })
    .execute();
  return id;
}

export async function account(
  db: Kysely<DB>,
  appId: string,
  ownerId: string,
  subject = 'USER_BALANCE',
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('ledger_accounts')
    .values({
      id,
      app_id: appId,
      owner_type: subject === 'USER_BALANCE' ? 'user' : 'platform',
      owner_id: ownerId,
      subject,
      created_at: new Date('2025-02-03T04:05:06.000Z'),
    })
    .execute();
  return id;
}

export async function balance(db: Kysely<DB>, appId: string, accountId: string): Promise<void> {
  await db
    .insertInto('account_balances')
    .values({
      app_id: appId,
      account_id: accountId,
      available_fen: -12345n,
      frozen_fen: 6789n,
      version: 17n,
      negative_since: '2025-02-04',
      created_at: new Date('2025-02-04T05:06:07.000Z'),
    })
    .execute();
}

export async function snapshot(db: Kysely<DB>, appIds: string[]) {
  return {
    users: await db
      .selectFrom('users')
      .selectAll()
      .where('app_id', 'in', appIds)
      .orderBy('id')
      .execute(),
    accounts: await db
      .selectFrom('ledger_accounts')
      .selectAll()
      .where('app_id', 'in', appIds)
      .orderBy('id')
      .execute(),
    balances: await db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', 'in', appIds)
      .orderBy('account_id')
      .execute(),
  };
}

export async function expectZeroAccount(db: Kysely<DB>, appId: string, uid: string) {
  // Query all subjects, so an extra self/promotion account cannot hide behind a filter.
  const accounts = await db
    .selectFrom('ledger_accounts')
    .selectAll()
    .where('app_id', '=', appId)
    .where('owner_type', '=', 'user')
    .where('owner_id', '=', uid)
    .execute();
  expect(accounts).toHaveLength(1);
  const row = accounts[0]!;
  expect(row).toMatchObject({
    app_id: appId,
    owner_type: 'user',
    owner_id: uid,
    subject: 'USER_BALANCE',
  });
  expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const balances = await db
    .selectFrom('account_balances')
    .selectAll()
    .where('account_id', '=', row.id)
    .execute();
  expect(balances).toHaveLength(1);
  expect(balances[0]).toMatchObject({
    app_id: appId,
    account_id: row.id,
    available_fen: 0n,
    frozen_fen: 0n,
    version: 0n,
    negative_since: null,
  });
  return row;
}
