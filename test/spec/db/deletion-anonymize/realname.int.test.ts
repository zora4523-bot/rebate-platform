// B1-15r §9.2 / D10-137: retain ciphertext only in the newly allowed none/tax_retained branch.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  REALNAME_PRIVATE,
  cleared,
  close,
  immutable,
  insert,
  open,
  read,
  ready,
  realname,
  sqlState,
  update,
  updatePrivileges,
  verified,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-15r#10] tax_retained is a required boolean defaulting to false for both ordinary states', async () => {
  await ready(h.app, 'realname');
  for (const state of [verified(), cleared()]) {
    const row = await realname(h.app, state);
    expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
    expect((await read(h.app, 'realname', row.id))['tax_retained']).toBe(false);
    expect(await sqlState(update(h.app, 'realname', row.id, { tax_retained: null }))).toBe('23502');
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            ...state,
            tax_retained: null,
          }),
        ),
      ),
    ).toBe('23502');
  }
});

it('[AC-B1-15r#11] none with tax_retained accepts all retained ciphertext, including without verification metadata', async () => {
  await ready(h.app, 'realname');
  for (const metadata of [{}, { provider: null, verified_at: null }]) {
    const row = await realname(h.app, { status: 'none', tax_retained: true, ...metadata });
    expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
    expect(await read(h.app, 'realname', row.id)).toMatchObject(row);
  }
});

it('[AC-B1-15r#12] couli_app can retain verified ciphertext under none and cannot unset the flag without clearing', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app);
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  const before = await read(h.app, 'realname', row.id);
  const retained = { status: 'none', tax_retained: true };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const changed = await update(h.app, 'realname', row.id, retained);
    expect(changed.rows).toEqual([{ ...before, ...retained }]);
  }
  expect(await sqlState(update(h.app, 'realname', row.id, { tax_retained: false }))).toBe('23514');
  expect(await read(h.app, 'realname', row.id)).toEqual({ ...before, ...retained });
  const cleaned = { ...cleared(), tax_retained: false };
  expect(await sqlState(update(h.app, 'realname', row.id, cleaned))).toBe('no error');
  expect(await read(h.app, 'realname', row.id)).toEqual({ ...before, ...cleaned });
});

it('[AC-B1-15r#13] default and false retention reject every residual private field under none or failed', async () => {
  await ready(h.app, 'realname');
  for (const flag of [{}, { tax_retained: false }]) {
    for (const status of ['none', 'failed']) {
      for (const name of REALNAME_PRIVATE) {
        const row = await realname(h.app, {
          ...cleared(),
          ...flag,
          status,
          [name]: verified()[name],
        });
        expect(await sqlState(insert(h.app, 'realname', row)), `${status}/${name}`).toBe('23514');
      }
    }
  }
});

it('[AC-B1-15r#14] tax_retained does not exempt failed rows or incomplete verified rows', async () => {
  await ready(h.app, 'realname');
  for (const name of REALNAME_PRIVATE) {
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            ...cleared(),
            status: 'failed',
            tax_retained: true,
            [name]: verified()[name],
          }),
        ),
      ),
      name,
    ).toBe('23514');
  }
  for (const tax_retained of [false, true]) {
    for (const name of [...REALNAME_PRIVATE, 'provider', 'verified_at']) {
      expect(
        await sqlState(
          insert(
            h.app,
            'realname',
            await realname(h.app, {
              tax_retained,
              [name]: null,
            }),
          ),
        ),
        `${tax_retained}/${name}`,
      ).toBe('23514');
    }
  }
});

it('[AC-B1-15r#15] ordinary unretained verified rows can still be cleared atomically', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app, { tax_retained: false });
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  const before = await read(h.app, 'realname', row.id);
  expect(await sqlState(update(h.app, 'realname', row.id, { status: 'none' }))).toBe('23514');
  expect(await read(h.app, 'realname', row.id)).toEqual(before);
  expect(await sqlState(update(h.app, 'realname', row.id, cleared()))).toBe('no error');
  expect(await read(h.app, 'realname', row.id)).toEqual({ ...before, ...cleared() });
});

it('[AC-B1-15r#16] tax_retained adds only column UPDATE while existing cleanup grants and immutable identity survive', async () => {
  await ready(h.app, 'realname');
  await updatePrivileges(h.app, 'realname', [
    ...REALNAME_PRIVATE,
    'status',
    'provider',
    'verified_at',
    'row_version',
    'updated_at',
    'tax_retained',
  ]);
  const row = await realname(h.app, { status: 'none', tax_retained: true });
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  await immutable(h.app, 'realname', await read(h.app, 'realname', row.id), [
    'id',
    'app_id',
    'user_id',
    'created_at',
  ]);
});

it('[AC-B1-15r#17] retained rows still enforce status, HMAC, provider and tenant integrity with validated checks', async () => {
  await ready(h.app, 'realname');
  for (const values of [{ status: 'unknown' }, { id_no_hmac: 'invalid' }, { provider: '   ' }]) {
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            status: 'none',
            tax_retained: true,
            ...values,
          }),
        ),
      ),
    ).toBe('23514');
  }
  const row = await realname(h.app, { status: 'none', tax_retained: true });
  expect(await sqlState(insert(h.app, 'realname', { ...row, app_id: 'wrong-app' }))).toBe('23503');
  const checks = await sql<{ validated: boolean }>`SELECT convalidated AS validated
    FROM pg_constraint WHERE conrelid = 'app.realname'::regclass AND contype = 'c'`.execute(h.app);
  expect(checks.rows.length).toBeGreaterThanOrEqual(5);
  expect(checks.rows.every((c) => c.validated)).toBe(true);
});
