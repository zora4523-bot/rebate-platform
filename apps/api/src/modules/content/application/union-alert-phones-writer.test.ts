import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type {
  UnionAlertPhonesTx,
  UnionAlertPhonesWrite,
} from '../infra/kysely-union-alert-phones-store.ts';
import {
  UnionAlertPhonesConflictError,
  UnionAlertPhonesInputError,
  unionAlertPhonesWriter,
  type UnionAlertPhonesInput,
} from './union-alert-phones-writer.ts';

const AT = '2031-03-04T05:06:07.000Z';
const KEY = 'union.auth_alert_phones';
const MARK = 'unitOpaqueMark';
const ADMIN = '0b6f2c4e-1d3a-4e5f-8a9b-0c1d2e3f4a5b';
const TRX = { isTransaction: true } as unknown as Transaction<DB>;
const INPUT: UnionAlertPhonesInput = {
  appId: 'a1',
  value: { cipher: `v1.${MARK}` },
  expectedVersion: 0,
  adminId: ADMIN,
  reason: 'add_phone',
};

function fixture(options: {
  lock?: number | undefined;
  insert?: number | undefined;
  update?: number | undefined;
}) {
  const calls: string[] = [];
  const writes: UnionAlertPhonesWrite[] = [];
  const tx: UnionAlertPhonesTx = {
    lockVersion: vi.fn(async () => {
      calls.push('lock');
      return options.lock;
    }),
    insert: vi.fn(async (write: UnionAlertPhonesWrite) => {
      calls.push('insert');
      writes.push(write);
      return options.insert;
    }),
    update: vi.fn(async (write: UnionAlertPhonesWrite, from: number) => {
      calls.push(`update@${from}`);
      writes.push(write);
      return options.update;
    }),
    history: vi.fn(async (write: UnionAlertPhonesWrite, version: number) => {
      calls.push(`history@${version}`);
      writes.push(write);
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const writer = unionAlertPhonesWriter({ clock: new FixedClock(AT), logger }, () => tx);
  const logged = () =>
    JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
  return { calls, writes, logger, logged, writer };
}

it('[AC-F1-02zzj-unit#1] 无行且 expectedVersion=0：先锁后插 version 1，写历史，键固定、值原样', async () => {
  const f = fixture({ lock: undefined, insert: 1 });
  expect(await f.writer.write(TRX, INPUT)).toEqual({ version: 1 });
  expect(f.calls).toEqual(['lock', 'insert', 'history@1']);
  expect(f.writes[0]).toEqual({
    appId: 'a1',
    key: KEY,
    valueJson: JSON.stringify(INPUT.value),
    updatedBy: ADMIN,
    adminId: ADMIN,
    reason: 'add_phone',
    at: new Date(AT),
  });
  expect(f.logged()).not.toContain(MARK);
});

it('[AC-F1-02zzj-unit#2] 有行且版本相符：按锁到的版本条件更新并写新版本历史', async () => {
  const f = fixture({ lock: 3, update: 4 });
  expect(await f.writer.write(TRX, { ...INPUT, expectedVersion: 3, reason: null })).toEqual({
    version: 4,
  });
  expect(f.calls).toEqual(['lock', 'update@3', 'history@4']);
  expect(f.writes[0]?.reason).toBeNull();
});

it.each([
  ['无行给 1', undefined, 1],
  ['有行 v3 给 0', 3, 0],
  ['有行 v3 给 2', 3, 2],
] as const)(
  '[AC-F1-02zzj-unit#3] 版本不符（%s）：冲突，不写',
  async (_label, lock, expectedVersion) => {
    const f = fixture({ lock, insert: 1, update: 4 });
    await expect(f.writer.write(TRX, { ...INPUT, expectedVersion })).rejects.toBeInstanceOf(
      UnionAlertPhonesConflictError,
    );
    expect(f.calls).toEqual(['lock']);
    expect(f.logged()).not.toContain(MARK);
  },
);

it('[AC-F1-02zzj-unit#4] 并发首写撞唯一键（插入落空）：冲突，不写历史', async () => {
  const f = fixture({ lock: undefined, insert: undefined });
  await expect(f.writer.write(TRX, INPUT)).rejects.toBeInstanceOf(UnionAlertPhonesConflictError);
  expect(f.calls).toEqual(['lock', 'insert']);
});

it('[AC-F1-02zzj-unit#5] 条件更新落空：冲突，不写历史', async () => {
  const f = fixture({ lock: 2, update: undefined });
  await expect(f.writer.write(TRX, { ...INPUT, expectedVersion: 2 })).rejects.toBeInstanceOf(
    UnionAlertPhonesConflictError,
  );
  expect(f.calls).toEqual(['lock', 'update@2']);
});

it('[AC-F1-02zzj-unit#6] 任意非 null 非数组对象都接受（含 {}），值不被解读', async () => {
  for (const value of [{}, { a: { b: [1, null, 'x'] } }]) {
    const f = fixture({ insert: 1 });
    expect(await f.writer.write(TRX, { ...INPUT, value })).toEqual({ version: 1 });
    expect(f.writes[0]?.valueJson).toBe(JSON.stringify(value));
  }
});

it.each([
  ['非事务', { isTransaction: false }],
  ['undefined', undefined],
  ['null', null],
])('[AC-F1-02zzj-unit#7] 事务参数%s：输入错误，什么都不调用', async (_label, trx) => {
  const f = fixture({ insert: 1 });
  await expect(f.writer.write(trx as unknown as Transaction<DB>, INPUT)).rejects.toBeInstanceOf(
    UnionAlertPhonesInputError,
  );
  expect(f.calls).toEqual([]);
});

const circular: Record<string, unknown> = {};
circular['self'] = circular;

it.each([
  ['多余字段 key', { key: KEY }],
  ['value=null', { value: null }],
  ['value 数组', { value: [] }],
  ['value 字符串', { value: '{}' }],
  ['value 循环引用', { value: circular }],
  ['value 为 Date', { value: new Date(AT) }],
  ['appId 空串', { appId: '' }],
  ['adminId 非 uuid', { adminId: `admin-${MARK}` }],
  ['expectedVersion 负数', { expectedVersion: -1 }],
  ['expectedVersion 非整数', { expectedVersion: 0.5 }],
  ['expectedVersion 超 int4', { expectedVersion: 2_147_483_647 }],
  ['reason 非字符串', { reason: 5 }],
  ['reason 超长', { reason: 'x'.repeat(201) }],
  ['reason 含控制字符', { reason: 'a\nb' }],
] as const)('[AC-F1-02zzj-unit#8] 入参%s：输入错误，不调用、不打日志', async (_label, patch) => {
  const f = fixture({ insert: 1 });
  await expect(
    f.writer.write(TRX, { ...INPUT, ...patch } as unknown as UnionAlertPhonesInput),
  ).rejects.toBeInstanceOf(UnionAlertPhonesInputError);
  expect(f.calls).toEqual([]);
  expect(f.logger.info).not.toHaveBeenCalled();
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.error).not.toHaveBeenCalled();
});

it('[AC-F1-02zzj-unit#9] 错误信息只带字段名，不带入参值', async () => {
  const f = fixture({ insert: 1 });
  const error = await f.writer
    .write(TRX, { ...INPUT, adminId: `admin-${MARK}` })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UnionAlertPhonesInputError);
  expect((error as UnionAlertPhonesInputError).field).toBe('adminId');
  expect((error as Error).message).not.toContain(MARK);
});
