// F1-02zzj §9.2 ①② / §9.3 ③④: only the caller's transaction is accepted, and the input is a
// whitelist (appId, value, expectedVersion, adminId, optional reason); the key is never the
// caller's choice. A rejected call is the input error and writes nothing.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import {
  UnionAlertPhonesInputError,
  type UnionAlertPhonesInput,
} from '../../../../apps/api/src/modules/content/index.ts';
import {
  MARK,
  cipherValue,
  databaseHarness,
  fixture,
  leaked,
  seedWritten,
  snapshot,
} from './kit.ts';

const h = databaseHarness(createTestDatabase);

it.each([
  ['根 db（非事务）', 'root'],
  ['不传事务（undefined）', undefined],
  ['null', null],
  ['普通对象', {}],
] as const)(
  '[AC-F1-02zzj#9] 事务参数为%s：输入错误，两表都不变',
  async (_label, kind) => {
    const f = fixture();
    const id = f.input.appId;
    await seedWritten(h.db, id, 1);
    const before = await snapshot(h.db, id);
    const trx = (kind === 'root' ? h.db : kind) as unknown as Transaction<DB>;
    // A root handle would autocommit every statement, so any write shows up below.
    await expect(async () =>
      f.writer.write(trx, { ...f.input, expectedVersion: 1, value: cipherValue('root') }),
    ).rejects.toBeInstanceOf(UnionAlertPhonesInputError);
    expect(await snapshot(h.db, id)).toEqual(before);
    expect(leaked(f.lines)).toEqual([]);
  },
);

const INVALID: readonly [string, Record<string, unknown>][] = [
  ['多余字段 key（即使就是该键）', { key: 'union.auth_alert_phones' }],
  ['多余字段 key（别的键）', { key: 'union.auth_alert_days' }],
  ['多余字段 version', { version: 2 }],
  ['多余字段 updatedBy', { updatedBy: 'someone' }],
  ['value=null', { value: null }],
  ['value 为数组', { value: [cipherValue('array')] }],
  ['value 为字符串', { value: JSON.stringify(cipherValue('string')) }],
  ['value 为数字', { value: 1 }],
  ['value 为布尔', { value: true }],
  ['adminId 空串', { adminId: '' }],
  ['adminId 非 uuid', { adminId: `admin-${MARK}` }],
  ['adminId 非字符串', { adminId: 42 }],
  ['appId 空串', { appId: '' }],
  ['appId 非字符串', { appId: 7 }],
  ['expectedVersion 负数', { expectedVersion: -1 }],
  ['expectedVersion 非整数', { expectedVersion: 1.5 }],
  ['expectedVersion NaN', { expectedVersion: Number.NaN }],
  ['expectedVersion 无穷', { expectedVersion: Number.POSITIVE_INFINITY }],
  ['expectedVersion 字符串', { expectedVersion: '1' }],
  ['reason 非字符串', { reason: 5 }],
];

it.each(INVALID)('[AC-F1-02zzj#10] 入参%s：输入错误，事务内与提交后两表都不变', async (_label, patch) => {
  const f = fixture();
  const id = f.input.appId;
  await seedWritten(h.db, id, 1);
  const before = await snapshot(h.db, id);
  // Otherwise valid for the seeded row (expectedVersion 1), so a lenient port would write.
  const input = { ...f.input, expectedVersion: 1, value: cipherValue('next'), ...patch };
  await h.db.transaction().execute(async (trx) => {
    await expect(async () =>
      f.writer.write(trx, input as unknown as UnionAlertPhonesInput),
    ).rejects.toBeInstanceOf(UnionAlertPhonesInputError);
    expect(await snapshot(trx, id)).toEqual(before);
  });
  expect(await snapshot(h.db, id)).toEqual(before);
  expect(leaked(f.lines)).toEqual([]);
});

it.each(['appId', 'value', 'expectedVersion', 'adminId'] as const)(
  '[AC-F1-02zzj#11] 缺必填字段 %s：输入错误，两表都不变',
  async (field) => {
    const f = fixture();
    const id = f.input.appId;
    await seedWritten(h.db, id, 1);
    const before = await snapshot(h.db, id);
    const input: Record<string, unknown> = {
      ...f.input,
      expectedVersion: 1,
      value: cipherValue('next'),
    };
    delete input[field];
    await h.db.transaction().execute(async (trx) => {
      await expect(async () =>
        f.writer.write(trx, input as unknown as UnionAlertPhonesInput),
      ).rejects.toBeInstanceOf(UnionAlertPhonesInputError);
      expect(await snapshot(trx, id)).toEqual(before);
    });
    expect(await snapshot(h.db, id)).toEqual(before);
  },
);

it.each([
  ['null', null],
  ['数组', []],
  ['字符串', 'union.auth_alert_phones'],
] as const)('[AC-F1-02zzj#12] 入参整体为%s：输入错误，两表都不变', async (_label, raw) => {
  const f = fixture();
  const id = f.input.appId;
  await seedWritten(h.db, id, 1);
  const before = await snapshot(h.db, id);
  await h.db.transaction().execute(async (trx) => {
    await expect(async () =>
      f.writer.write(trx, raw as unknown as UnionAlertPhonesInput),
    ).rejects.toBeInstanceOf(UnionAlertPhonesInputError);
  });
  expect(await snapshot(h.db, id)).toEqual(before);
});
