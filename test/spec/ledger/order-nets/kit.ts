import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { subFen } from '@couli/money';
import type { Kysely } from 'kysely';
import type { OrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  account,
  entry,
  platform,
  voucher,
  type Account,
  type Row,
} from '../../db/ledger/invariants/kit.ts';

export { account, entry, platform, voucher } from '../../db/ledger/invariants/kit.ts';
export { snapshot } from '../posting/kit.ts';
export const TIMEOUT = 60_000;

interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<TestDatabase>) {
  const database = await create();
  return {
    database,
    db: createDb({ connectionString: database.urlFor('couli_app'), max: 1 }),
    reader: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}

export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.reader)]);
  await h.database.drop();
}

export async function fixture(db: Kysely<DB>, appId = `order-nets-${randomUUID()}`) {
  // No identity/order rows or account_balances: the port needs only ledger history.
  const user = await account(db, { app_id: appId });
  const other = await account(db, { app_id: appId });
  const revenue = await platform(db, 'COMMISSION_REVENUE', appId);
  const receivable = await platform(db, 'UNION_RECEIVABLE:taobao', appId);
  const debt = await platform(db, 'BAD_DEBT', appId);
  return {
    appId,
    orderKey: `taobao:child:${randomUUID()}`,
    user,
    other,
    revenue,
    receivable,
    debt,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Explicit balanced storage fixtures; expected nets in tests are handwritten constants. */
export async function transfer(
  db: Kysely<DB>,
  scope: { appId: string; orderKey: string },
  debit: Account,
  credit: Account,
  amount: bigint,
  metadata: Row,
  line: Row = {},
) {
  const v = await voucher(db, {
    app_id: scope.appId,
    order_key: scope.orderKey,
    ...metadata,
  });
  await entry(db, debit, v, amount, line);
  await entry(db, credit, v, subFen(0n, amount), line);
  return v;
}

export function key(f: Fixture, kind: string, role = 'self', user = f.user) {
  return { voucher_kind: kind, beneficiary_user_id: user.owner_id, role };
}

export function ordered(nets: OrderNets): OrderNets {
  return {
    ...nets,
    beneficiaries: [...nets.beneficiaries].sort((a, b) =>
      `${a.beneficiary_user_id}:${a.role}`.localeCompare(`${b.beneficiary_user_id}:${b.role}`),
    ),
  };
}
