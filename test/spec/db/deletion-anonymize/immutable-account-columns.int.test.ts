// B1-15r D10-269: the seven account columns of app.payout_accounts change only in the one UPDATE
// that anonymizes the row, and anonymized_at is final once set. Rejections are restrict_violation
// (SQLSTATE 23001), asserted by code only, always as couli_app.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  anonymized,
  close,
  insert,
  open,
  payout,
  read,
  ready,
  sqlState,
  update,
  type Harness,
  type Row,
} from './kit.ts';

type Method = 'alipay' | 'bank_card';
type AccountColumn =
  | 'alipay_logon_id_cipher'
  | 'alipay_hmac'
  | 'bank_card_no_cipher'
  | 'bank_card_hmac'
  | 'bank_name'
  | 'card_bin'
  | 'payee_name';

const METHODS: readonly Method[] = ['alipay', 'bank_card'];
const ACCOUNT_COLUMNS: readonly AccountColumn[] = [
  'alipay_logon_id_cipher',
  'alipay_hmac',
  'bank_card_no_cipher',
  'bank_card_hmac',
  'bank_name',
  'card_bin',
  'payee_name',
];
const RESTRICT_VIOLATION = '23001';
const LATER = new Date('2026-10-24T05:06:07.890Z');

// Non-null values that differ from every fixture value in kit.ts. On a live row of the matching
// method they keep payout_accounts_details_check satisfied, so only the update guard can refuse.
const REPLACEMENT: Record<AccountColumn, unknown> = {
  alipay_logon_id_cipher: Buffer.from('synthetic-alipay-other'),
  alipay_hmac: 'b'.repeat(64),
  bank_card_no_cipher: Buffer.from('synthetic-bank-card-other'),
  bank_card_hmac: 'c'.repeat(64),
  bank_name: 'fixture-bank-other',
  card_bin: '621700',
  payee_name: '另一姓名',
};

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

async function stored(method: Method, values: Row = {}): Promise<Row> {
  const row = await payout(h.app, method, values);
  expect(await sqlState(insert(h.app, 'payout_accounts', row))).toBe('no error');
  return read(h.app, 'payout_accounts', row.id);
}

function accountOf(row: Row): Row {
  return Object.fromEntries(ACCOUNT_COLUMNS.map((name) => [name, row[name]]));
}

async function rejected(before: Row, values: Row, label: string): Promise<void> {
  const state = await sqlState(update(h.app, 'payout_accounts', before['id'], values));
  expect(state, label).toBe(RESTRICT_VIOLATION);
  expect(await read(h.app, 'payout_accounts', before['id']), label).toEqual(before);
}

it('[AC-B1-15r#18] a non-anonymized account cannot change any of the seven account columns, alone or with other columns', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of METHODS) {
    for (const is_current of [true, false]) {
      const before = await stored(method, { is_current });
      expect(before['anonymized_at']).toBeNull();
      for (const name of ACCOUNT_COLUMNS) {
        const label = `${method}/${is_current}/${name}`;
        await rejected(before, { [name]: REPLACEMENT[name] }, label);
        const kept = { [name]: REPLACEMENT[name], anonymized_at: null, row_version: 1 };
        await rejected(before, kept, `${label} with anonymized_at NULL`);
      }
      const present = ACCOUNT_COLUMNS.filter((name) => before[name] !== null);
      const swap = Object.fromEntries(present.map((name) => [name, REPLACEMENT[name]]));
      await rejected(before, swap, `${method}/${is_current} whole account`);
    }
  }
});

it('[AC-B1-15r#19] unrelated granted columns and same-value writes stay updatable on a live account', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of METHODS) {
    const before = await stored(method);
    await rejected(before, { payee_name: REPLACEMENT.payee_name }, `${method} payee`);
    const allowed = { row_version: 1, updated_at: AT, is_current: false };
    const values = { ...accountOf(before), ...allowed };
    const state = await sqlState(update(h.app, 'payout_accounts', before['id'], values));
    expect(state, `${method} same values`).toBe('no error');
    expect(await read(h.app, 'payout_accounts', before['id'])).toEqual({ ...before, ...allowed });
  }
});

it('[AC-B1-15r#20] anonymized_at is final and an anonymized account cannot change any account column', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of METHODS) {
    for (const bank_name of [null, 'fixture-bank']) {
      const before = await stored(method, { ...anonymized(), bank_name });
      const label = `${method}/${String(bank_name)}`;
      await rejected(before, { anonymized_at: LATER }, `${label} moved`);
      await rejected(before, { anonymized_at: null }, `${label} back to NULL`);
      const again = { anonymized_at: LATER, payee_name: '已注销-2' };
      await rejected(before, again, `${label} anonymized again`);
      for (const name of ACCOUNT_COLUMNS) {
        await rejected(before, { [name]: REPLACEMENT[name] }, `${label}/${name}`);
        const kept = { [name]: REPLACEMENT[name], anonymized_at: AT };
        await rejected(before, kept, `${label}/${name} with anonymized_at kept`);
      }
    }
  }
});

it('[AC-B1-15r#21] only the single anonymizing UPDATE may clear the account, and the result is then frozen', async () => {
  await ready(h.app, 'payout_accounts');
  for (const method of METHODS) {
    const variants: Row[] = [anonymized()];
    if (method === 'bank_card') {
      variants.push({ ...anonymized(), bank_name: 'fixture-bank' });
    }
    for (const values of variants) {
      const before = await stored(method);
      const label = `${method}/${String(values['bank_name'])}`;
      const state = await sqlState(update(h.app, 'payout_accounts', before['id'], values));
      expect(state, `${label} anonymizing update`).toBe('no error');
      const after = await read(h.app, 'payout_accounts', before['id']);
      expect(after).toEqual({ ...before, ...values });
      await rejected(after, { anonymized_at: LATER }, `${label} moved`);
      await rejected(after, { payee_name: '已注销-2' }, `${label} placeholder`);
      await rejected(after, { ...accountOf(before), anonymized_at: null }, `${label} restored`);
    }
  }
});
