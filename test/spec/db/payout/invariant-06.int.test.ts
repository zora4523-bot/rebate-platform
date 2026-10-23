import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  TIMEOUT,
  close,
  insert,
  open,
  person,
  ready,
  statusFields,
  withdrawal,
  type Connection,
  type Harness,
} from './kit.ts';

interface Result {
  invariant: string;
  checked_rows: bigint;
  scope: string;
  app_id: string | null;
  account_id: string | null;
  detail: Record<string, unknown> | null;
}

async function scenario(
  run: (h: Harness, check: () => Promise<Result[]>, baseline: bigint) => Promise<void>,
) {
  const h = await open(createTestDatabase);
  try {
    await ready(h.app);
    const path = new URL(
      '../../../../db/invariants/ledger/06_frozen-equals-open-withdrawals.sql',
      import.meta.url,
    );
    expect(existsSync(path), 'invariant 06 SQL must exist').toBe(true);
    const source = readFileSync(path, 'utf8');
    const text = source.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
      token.startsWith("'") ? token : ' ',
    );
    const tokens = text
      .replace(/'(?:''|[^'])*'/g, ' ')
      .trim()
      .replace(/;\s*$/, '');
    expect(tokens).toMatch(/^(SELECT|WITH)\b/i);
    expect(tokens).not.toContain(';');
    expect(tokens).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
    );
    expect(tokens).not.toMatch(
      /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
    );
    const query = text.trim().replace(/;\s*$/, '');
    const baseline = (
      await sql<{
        count: bigint;
      }>`SELECT count(*) AS count FROM (
        SELECT app_id, owner_id FROM app.ledger_accounts WHERE owner_type = 'user'
        UNION
        SELECT app_id, user_id::text AS owner_id FROM app.withdrawals
        WHERE status IN ('PENDING_REVIEW', 'APPROVED', 'PAYING')
      ) users_to_check`.execute(h.app)
    ).rows[0]!.count;
    await run(
      h,
      async () =>
        h.roles.couli_readonly
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            const rows = (await sql.raw<Result>(query).execute(trx)).rows;
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
              expect(Object.keys(row).sort()).toEqual([
                'account_id',
                'app_id',
                'checked_rows',
                'detail',
                'invariant',
                'scope',
              ]);
              expect(row.invariant).toBe('06');
              expect(typeof row.checked_rows).toBe('bigint');
              expect(row.checked_rows).toBe(rows[0]!.checked_rows);
              expect(['none', 'account']).toContain(row.scope);
            }
            const types = await sql
              .raw<Record<string, string>>(
                `SELECT pg_typeof(invariant)::text AS invariant,
        pg_typeof(checked_rows)::text AS checked_rows, pg_typeof(scope)::text AS scope,
        pg_typeof(app_id)::text AS app_id, pg_typeof(account_id)::text AS account_id,
        pg_typeof(detail)::text AS detail FROM (${query}) r LIMIT 1`,
              )
              .execute(trx);
            expect(types.rows).toEqual([
              {
                invariant: 'text',
                checked_rows: 'bigint',
                scope: 'text',
                app_id: 'text',
                account_id: 'uuid',
                detail: 'jsonb',
              },
            ]);
            return rows;
          }),
      baseline,
    );
  } finally {
    await close(h);
  }
}

async function account(
  db: Connection,
  owner: { app_id: string; user_id: string },
  frozen: bigint | null,
) {
  const id = randomUUID();
  await insert(db, 'ledger_accounts', {
    id,
    app_id: owner.app_id,
    owner_type: 'user',
    owner_id: owner.user_id,
    subject: 'USER_BALANCE',
  });
  if (frozen !== null)
    await insert(db, 'account_balances', {
      app_id: owner.app_id,
      account_id: id,
      available_fen: 0n,
      frozen_fen: frozen,
      version: 0n,
    });
  return id;
}
function clean(rows: Result[], count: bigint) {
  expect(rows).toEqual([
    {
      invariant: '06',
      checked_rows: count,
      scope: 'none',
      app_id: null,
      account_id: null,
      detail: null,
    },
  ]);
}
function difference(
  rows: Result[],
  appId: string,
  accountId: string,
  count: bigint,
  ...amounts: string[]
) {
  const row = rows.find((r) => r.account_id === accountId && r.app_id === appId);
  expect(row).toMatchObject({ invariant: '06', checked_rows: count, scope: 'account' });
  expect(row?.detail).not.toBeNull();
  expect(row?.detail).toBeTypeOf('object');
  const leaves = (value: unknown): unknown[] =>
    value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
  // Strict string matching: a JSON numeric amount must not satisfy this assertion.
  for (const amount of amounts) expect(leaves(row?.detail)).toContain(amount);
}

it(
  '[AC-B2-05b#17] 06 相等不报：三个非终态按申请额求和，四终态排除，空账户计入 checked_rows',
  async () => {
    await scenario(async (h, check, baseline) => {
      const owner = await person(h.app);
      await account(h.app, owner, 7000n);
      // Distinct amounts prevent one wrongly included terminal state from masking
      // one omitted open state while leaving the aggregate unchanged.
      for (const [status, amount_fen, net_fen] of [
        ['PENDING_REVIEW', 1000n, 700n],
        ['APPROVED', 2000n, 1700n],
        ['PAYING', 4000n, 3700n],
        ['REJECTED', 8000n, 7700n],
        ['PAID_API', 16000n, 15700n],
        ['PAID_MANUAL', 32000n, 31700n],
        ['FAILED', 64000n, 63700n],
      ] as const) {
        await insert(
          h.app,
          'withdrawals',
          withdrawal(owner, {
            ...statusFields(status),
            fee_fen: 100n,
            tax_fen: 200n,
            amount_fen,
            net_fen,
          }),
        );
      }
      await account(h.app, await person(h.app, owner.app_id), 0n);
      // Same owner_id in another tenant must not join the first tenant's withdrawals.
      await account(h.app, { app_id: `other-${randomUUID()}`, user_id: owner.user_id }, 0n);
      // Platform balances neither contribute differences nor increase checked_rows.
      const platformId = randomUUID();
      await insert(h.app, 'ledger_accounts', {
        id: platformId,
        app_id: owner.app_id,
        owner_type: 'platform',
        owner_id: 'platform',
        subject: 'CASH_ALIPAY',
      });
      await insert(h.app, 'account_balances', {
        app_id: owner.app_id,
        account_id: platformId,
        available_fen: 0n,
        frozen_fen: 999n,
        version: 0n,
      });
      clean(await check(), baseline + 3n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-05b#18] 06 冻结多出、冻结不足和无在途但有冻结逐账户报差异，金额为精确文本',
  async () => {
    await scenario(async (h, check, baseline) => {
      const high = await person(h.app);
      const highAccount = await account(h.app, high, 9007199254740994n);
      await insert(
        h.app,
        'withdrawals',
        withdrawal(high, { amount_fen: 9007199254740993n, net_fen: 9007199254740993n }),
      );
      const low = await person(h.app, high.app_id);
      const lowAccount = await account(h.app, low, 999n);
      await insert(h.app, 'withdrawals', withdrawal(low, { status: 'APPROVED' }));
      const empty = await person(h.app);
      const emptyAccount = await account(h.app, empty, 1n);
      await insert(h.app, 'withdrawals', withdrawal(empty, statusFields('FAILED')));
      const rows = await check();
      expect(rows).toHaveLength(3);
      difference(
        rows,
        high.app_id,
        highAccount,
        baseline + 3n,
        '9007199254740994',
        '9007199254740993',
      );
      difference(rows, low.app_id, lowAccount, baseline + 3n, '999', '1000');
      difference(rows, empty.app_id, emptyAccount, baseline + 3n, '1', '0');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-05b#19] 06 有在途无余额行仍报账户差异，不被其他 app 同 owner 的余额掩盖',
  async () => {
    await scenario(async (h, check, baseline) => {
      const owner = await person(h.app);
      const id = await account(h.app, owner, null);
      await insert(
        h.app,
        'withdrawals',
        withdrawal(owner, { status: 'PAYING', needs_manual: true }),
      );
      await account(h.app, { app_id: `other-${randomUUID()}`, user_id: owner.user_id }, 0n);
      const rows = await check();
      expect(rows).toHaveLength(1);
      difference(rows, owner.app_id, id, baseline + 2n, '1000');
      expect(rows[0]?.detail).toEqual(
        expect.objectContaining({ balance_present: false, frozen_fen: null }),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-05b#20] 06 有在途无账本账户仍报差异，并集按 app 与用户去重计数',
  async () => {
    await scenario(async (h, check, baseline) => {
      const owner = await person(h.app);
      for (const status of ['PENDING_REVIEW', 'APPROVED', 'PAYING']) {
        await insert(h.app, 'withdrawals', withdrawal(owner, { status }));
      }
      const other = await person(h.app, owner.app_id);
      await insert(h.app, 'withdrawals', withdrawal(other));
      // A terminal-only user without an account is outside the union.
      await insert(
        h.app,
        'withdrawals',
        withdrawal(await person(h.app, owner.app_id), statusFields('FAILED')),
      );
      // An account in another tenant cannot hide either missing account.
      await account(h.app, { app_id: `other-${randomUUID()}`, user_id: owner.user_id }, 0n);
      const rows = await check();
      expect(rows).toHaveLength(2);
      for (const [userId, amount] of [
        [owner.user_id, '3000'],
        [other.user_id, '1000'],
      ]) {
        expect(rows).toContainEqual({
          invariant: '06',
          checked_rows: baseline + 3n,
          scope: 'account',
          app_id: owner.app_id,
          account_id: null,
          detail: {
            user_id: userId,
            balance_present: false,
            frozen_fen: null,
            open_amount_fen: amount,
          },
        });
      }
    });
  },
  TIMEOUT,
);
