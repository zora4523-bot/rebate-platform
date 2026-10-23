// B1-15r §9.2 / D10-186: anonymize in place; no DELETE or changes to ownership.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  PAYOUT_PRIVATE,
  anonymized,
  close,
  columns,
  immutable,
  insert,
  open,
  payout,
  payoutDetails,
  person,
  read,
  ready,
  sqlState,
  update,
  updatePrivileges,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-15r#1] anonymized_at is nullable timestamptz without a clock default; payee_name stays required', async () => {
  await ready(h.app, 'payout_accounts');
  expect(await columns(h.app, 'payout_accounts')).toContainEqual({
    name: 'payee_name',
    type: 'text',
    nullable: false,
    default: null,
  });
  for (const method of ['alipay', 'bank_card'] as const) {
    const row = await payout(h.app, method);
    expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
    expect((await read(h.app, 'payout_accounts', row.id))['anonymized_at']).toBeNull();
    expect(
      await sqlState(
        insert(
          h.app,
          'payout_accounts',
          await payout(h.app, method, { ...anonymized(), payee_name: null }),
        ),
      ),
    ).toBe('23502');
  }
});

it('[AC-B1-15r#2] both methods accept anonymized skeletons with an optional bank name and a placeholder payee', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of ['alipay', 'bank_card'] as const) {
    for (const bank_name of [null, 'fixture-bank']) {
      const row = await payout(h.app, method, { ...anonymized(), bank_name });
      expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
      expect(await read(h.app, 'payout_accounts', row.id)).toMatchObject(row);
    }
  }
});

it('[AC-B1-15r#3] couli_app clears each method atomically, preserves the row, and can repeat the cleanup', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of ['alipay', 'bank_card'] as const) {
    const row = await payout(h.app, method);
    expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
    const before = await read(h.app, 'payout_accounts', row.id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const changed = await update(h.app, 'payout_accounts', row.id, anonymized());
      expect(changed.rows).toEqual([{ ...before, ...anonymized() }]);
      expect(await read(h.app, 'payout_accounts', row.id)).toEqual({ ...before, ...anonymized() });
    }
  }
});

it('[AC-B1-15r#4] non-anonymized current and historical accounts still require every method-specific field', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of ['alipay', 'bank_card'] as const) {
    const required =
      method === 'alipay'
        ? ['alipay_logon_id_cipher', 'alipay_hmac']
        : ['bank_card_no_cipher', 'bank_card_hmac', 'bank_name', 'card_bin'];
    const opposite =
      method === 'alipay'
        ? ['bank_card_no_cipher', 'bank_card_hmac', 'bank_name', 'card_bin']
        : ['alipay_logon_id_cipher', 'alipay_hmac'];
    for (const is_current of [true, false]) {
      expect(
        await sqlState(
          insert(
            h.app,
            'payout_accounts',
            await payout(h.app, method, { ...anonymized(), anonymized_at: null, is_current }),
          ),
        ),
        `${method}/${is_current}: cleared fields require anonymized_at`,
      ).toBe('23514');
      for (const name of required) {
        expect(
          await sqlState(
            insert(
              h.app,
              'payout_accounts',
              await payout(h.app, method, {
                anonymized_at: null,
                is_current,
                [name]: null,
              }),
            ),
          ),
          `${method}/${is_current}/${name}`,
        ).toBe('23514');
      }
      for (const name of opposite) {
        const other = payoutDetails(method === 'alipay' ? 'bank_card' : 'alipay');
        expect(
          await sqlState(
            insert(
              h.app,
              'payout_accounts',
              await payout(h.app, method, {
                anonymized_at: null,
                is_current,
                [name]: other[name],
              }),
            ),
          ),
          `${method}/${is_current}/${name}`,
        ).toBe('23514');
      }
    }
  }
});

it('[AC-B1-15r#5] anonymized rows cannot retain any identifier, even a complete formerly valid account', async () => {
  await ready(h.app, 'payout_accounts');
  const identifiers: Record<string, unknown> = {
    ...payoutDetails('bank_card'),
    alipay_logon_id_cipher: Buffer.from('synthetic-alipay'),
    alipay_hmac: 'a'.repeat(64),
  };
  for (const method of ['alipay', 'bank_card'] as const) {
    for (const name of PAYOUT_PRIVATE) {
      expect(
        await sqlState(
          insert(
            h.app,
            'payout_accounts',
            await payout(h.app, method, {
              ...anonymized(),
              [name]: identifiers[name],
            }),
          ),
        ),
        `${method}/${name}`,
      ).toBe('23514');
    }
    const row = await payout(h.app, method, { is_current: false });
    expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
    expect(await sqlState(update(h.app, 'payout_accounts', row.id, { anonymized_at: AT }))).toBe(
      '23514',
    );
    expect((await read(h.app, 'payout_accounts', row.id))['anonymized_at']).toBeNull();
  }
});

it('[AC-B1-15r#6] an anonymized account cannot be current on insert or update', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of ['alipay', 'bank_card'] as const) {
    const row = await payout(h.app, method, anonymized());
    expect(await sqlState(insert(h.app, 'payout_accounts', { ...row, is_current: true }))).toBe(
      '23514',
    );
    expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
    expect(await sqlState(update(h.app, 'payout_accounts', row.id, { is_current: true }))).toBe(
      '23514',
    );
    expect(await read(h.app, 'payout_accounts', row.id)).toMatchObject(row);
  }
});

it('[AC-B1-15r#7] cleanup adds only the specified column grants and never DELETE or ownership updates', async () => {
  await ready(h.app, 'payout_accounts');
  await updatePrivileges(h.app, 'payout_accounts', [
    ...PAYOUT_PRIVATE,
    'bank_name',
    'payee_name',
    'anonymized_at',
    'is_current',
    'row_version',
    'updated_at',
  ]);
  const row = await payout(h.app, 'alipay', anonymized());
  expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
  await immutable(h.app, 'payout_accounts', await read(h.app, 'payout_accounts', row.id), [
    'id',
    'app_id',
    'user_id',
    'payout_method',
    'created_at',
  ]);
});

it('[AC-B1-15r#8] anonymization frees the current slots while all three scoped unique rules survive', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of ['alipay', 'bank_card'] as const) {
    const row = await payout(h.app, method);
    expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
    const otherOwner = await person(h.app, row.app_id);
    const other = { ...row, ...otherOwner, id: randomUUID() };
    expect(await sqlState(insert(h.app, 'payout_accounts', other))).toBe('23505');
    const otherMethod = {
      ...row,
      ...payoutDetails(method === 'alipay' ? 'bank_card' : 'alipay'),
      id: randomUUID(),
    };
    expect(await sqlState(insert(h.app, 'payout_accounts', otherMethod))).toBe('23505');
    expect(await sqlState(insert(h.app, 'payout_accounts', await payout(h.app, method)))).toBe(
      'no error',
    );
    expect(await sqlState(update(h.app, 'payout_accounts', row.id, anonymized()))).toBe('no error');
    expect(await sqlState(insert(h.app, 'payout_accounts', other))).toBe('no error');
    expect(await sqlState(insert(h.app, 'payout_accounts', otherMethod))).toBe('no error');
    expect(await read(h.app, 'payout_accounts', row.id)).toMatchObject({ ...row, ...anonymized() });
  }
});

it('[AC-B1-15r#9] anonymization preserves the method check, tenant foreign key and validated checks', async () => {
  await ready(h.app, 'payout_accounts');
  const row = await payout(h.app, 'alipay', anonymized());
  expect(
    await sqlState(insert(h.app, 'payout_accounts', { ...row, payout_method: 'unknown' })),
  ).toBe('23514');
  expect(await sqlState(insert(h.app, 'payout_accounts', { ...row, app_id: 'wrong-app' }))).toBe(
    '23503',
  );
  expect(await sqlState(insert(h.app, 'payout_accounts', { ...row, user_id: randomUUID() }))).toBe(
    '23503',
  );
  const checks = await sql<{ validated: boolean }>`SELECT convalidated AS validated
    FROM pg_constraint WHERE conrelid = 'app.payout_accounts'::regclass AND contype = 'c'`.execute(
    h.app,
  );
  expect(checks.rows.length).toBeGreaterThanOrEqual(2);
  expect(checks.rows.every((c) => c.validated)).toBe(true);
});
