import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type {
  SystemSwitchRow,
  SystemSwitchTx,
  SystemSwitchWrite,
} from '../infra/kysely-system-switch-store.ts';
import {
  SystemSwitchInputError,
  systemSwitchWriter,
  type SystemSwitchInput,
} from './system-switch-writer.ts';

const AT = '2031-03-04T05:06:07.000Z';
const KEY = 'settle.auto.enabled';
const TRX = { isTransaction: true } as unknown as Transaction<DB>;
const INPUT: SystemSwitchInput = { appId: 'a1', key: KEY, source: 'daily_check', reason: 'diff' };

/** Fake statements: `locks` answers successive lock() calls; inserts/updates as given. */
function fixture(options: {
  locks?: (SystemSwitchRow | undefined)[];
  insert?: SystemSwitchRow | undefined;
  update?: SystemSwitchRow | undefined;
}) {
  const calls: string[] = [];
  const writes: SystemSwitchWrite[] = [];
  const locks = [...(options.locks ?? [undefined])];
  const tx: SystemSwitchTx = {
    lock: vi.fn(async () => {
      calls.push('lock');
      return locks.shift();
    }),
    insertOff: vi.fn(async (write: SystemSwitchWrite) => {
      calls.push('insert');
      writes.push(write);
      return options.insert;
    }),
    updateOff: vi.fn(async (write: SystemSwitchWrite, from: number) => {
      calls.push(`update@${from}`);
      writes.push(write);
      return options.update;
    }),
    history: vi.fn(async (write: SystemSwitchWrite, version: number) => {
      calls.push(`history@${version}`);
      writes.push(write);
    }),
  };
  const warn = vi.fn();
  const txOf = vi.fn(() => tx);
  const writer = systemSwitchWriter({ clock: new FixedClock(AT), logger: { warn } }, txOf);
  return { calls, writes, warn, txOf, writer };
}

it('[AC-F1-02zk-unit#1] 无行：先锁后插 version 1，写 system 历史，turnOff 内不告警', async () => {
  const f = fixture({ insert: { value: false, version: 1 } });
  const result = await f.writer.turnOff(TRX, INPUT);
  expect(result).toEqual({ key: KEY, changed: true, version: 1, fromValue: null });
  expect(f.calls).toEqual(['lock', 'insert', 'history@1']);
  expect(f.writes[0]).toEqual({
    appId: 'a1',
    key: KEY,
    updatedBy: 'system',
    reason: 'daily_check:diff',
    at: new Date(AT),
  });
  expect(f.warn).not.toHaveBeenCalled();
});

it('[AC-F1-02zk-unit#2] 首插冲突：重锁后按现值决定，已是 false 不写', async () => {
  const f = fixture({ locks: [undefined, { value: false, version: 1 }], insert: undefined });
  const result = await f.writer.turnOff(TRX, INPUT);
  expect(result).toEqual({ key: KEY, changed: false, version: 1, fromValue: false });
  expect(f.calls).toEqual(['lock', 'insert', 'lock']);
});

it('[AC-F1-02zk-unit#3] 首插冲突后现值为 true：按锁到的版本更新并写历史', async () => {
  const f = fixture({
    locks: [undefined, { value: true, version: 1 }],
    insert: undefined,
    update: { value: false, version: 2 },
  });
  const result = await f.writer.turnOff(TRX, INPUT);
  expect(result).toEqual({ key: KEY, changed: true, version: 2, fromValue: true });
  expect(f.calls).toEqual(['lock', 'insert', 'lock', 'update@1', 'history@2']);
});

it.each([true, 'false', 0, null, { corrupt: true }])(
  '[AC-F1-02zk-unit#4] 现值 %j 不是布尔 false：更新为 false 并 +1',
  async (value) => {
    const f = fixture({ locks: [{ value, version: 3 }], update: { value: false, version: 4 } });
    expect(await f.writer.turnOff(TRX, INPUT)).toEqual({
      key: KEY,
      changed: true,
      version: 4,
      fromValue: value,
    });
    expect(f.calls).toEqual(['lock', 'update@3', 'history@4']);
  },
);

it('[AC-F1-02zk-unit#5] 已是 false：只锁不写，告警也不发', async () => {
  const f = fixture({ locks: [{ value: false, version: 3 }] });
  const result = await f.writer.turnOff(TRX, INPUT);
  expect(result).toEqual({ key: KEY, changed: false, version: 3, fromValue: false });
  expect(f.calls).toEqual(['lock']);
  f.writer.alertCommitted(INPUT, result);
  expect(f.warn).not.toHaveBeenCalled();
});

it('[AC-F1-02zk-unit#6] 锁住的行更新落空或冲突后行消失：抛错，不写历史', async () => {
  const miss = fixture({ locks: [{ value: true, version: 3 }], update: undefined });
  await expect(miss.writer.turnOff(TRX, INPUT)).rejects.toThrow('locked row changed');
  expect(miss.calls).toEqual(['lock', 'update@3']);
  const gone = fixture({ locks: [undefined, undefined], insert: undefined });
  await expect(gone.writer.turnOff(TRX, INPUT)).rejects.toThrow('vanished');
  expect(gone.calls).toEqual(['lock', 'insert', 'lock']);
});

it.each([
  [{ isTransaction: false }, INPUT, 'transaction'],
  [null, INPUT, 'transaction'],
  [TRX, { ...INPUT, key: 'payout.queue_paused' }, 'key'],
  [TRX, { ...INPUT, key: 'withdraw.enabled' }, 'key'],
  [TRX, { ...INPUT, key: '__proto__' }, 'key'],
  [TRX, { ...INPUT, appId: '' }, 'appId'],
  [TRX, { ...INPUT, source: 'Daily' }, 'source'],
  [TRX, { ...INPUT, source: 'daily_check\n' }, 'source'],
  [TRX, { ...INPUT, source: '_x' }, 'source'],
  [TRX, { ...INPUT, source: 'a'.repeat(33) }, 'source'],
  [TRX, { ...INPUT, reason: '   ' }, 'reason'],
  [TRX, { ...INPUT, reason: 'a\u0000b' }, 'reason'],
  [TRX, { ...INPUT, source: 'src', reason: 'a'.repeat(197) }, 'reason'],
  [TRX, { ...INPUT, value: true }, 'value'],
])('[AC-F1-02zk-unit#7] 非法参数在任何语句前拒绝（%#）', async (trx, input, field) => {
  const f = fixture({});
  const error = await f.writer
    .turnOff(trx as unknown as Transaction<DB>, input as SystemSwitchInput)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SystemSwitchInputError);
  expect((error as SystemSwitchInputError).field).toBe(field);
  expect(f.txOf).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});

it('[AC-F1-02zk-unit#8] 来源与原因边界：组合正好 200 个码点可写，按码点计数', async () => {
  const f = fixture({ insert: { value: false, version: 1 } });
  await f.writer.turnOff(TRX, { ...INPUT, source: 'src', reason: 'a'.repeat(196) });
  const g = fixture({ insert: { value: false, version: 1 } });
  await g.writer.turnOff(TRX, { ...INPUT, source: 'a'.repeat(32), reason: '差'.repeat(167) });
  expect(f.writes[0]?.reason).toHaveLength(200);
  expect([...(g.writes[0]?.reason ?? '')]).toHaveLength(200);
});

it('[AC-F1-02zk-unit#9] alertCommitted：changed 才发一条 config_change_alert，actor system', () => {
  const f = fixture({});
  f.writer.alertCommitted(INPUT, { key: KEY, changed: true, version: 4, fromValue: true });
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.warn).toHaveBeenCalledWith(
    {
      key: KEY,
      from_value: true,
      to_value: false,
      version: 4,
      app_id: 'a1',
      actor: 'system',
      source: 'daily_check',
      reason: 'diff',
    },
    'config_change_alert',
  );
});
