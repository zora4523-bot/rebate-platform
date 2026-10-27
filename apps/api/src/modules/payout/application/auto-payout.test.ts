// Unit tests of the automatic payout configuration snapshot (BR-WDR-30 可追溯) without a database:
// the port is a scripted map whose values change between reads, as a batch save committing in
// the middle of a per-key read would. The decision itself runs against PostgreSQL in the rule
// tests (test/spec/payout/auto-payout).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  AUTO_PAYOUT_DEFAULTS,
  autoPayoutConfigOf,
  readAutoPayoutConfigSnapshot,
  type AutoPayoutConfigEntry,
  type AutoPayoutConfigPort,
} from './auto-payout.ts';

const APP = 'app_unit';
const HANDLE = {} as Kysely<DB>;
const MAX = 'withdraw.auto_payout.max_amount_fen';
const USER_DAILY = 'withdraw.auto_payout.user_daily_max_count';
const KEYS = [MAX, USER_DAILY];

/** Old saved state {30000, 1} (versions 1); the batch save makes it {10000, 3} (versions 2). */
const OLD = new Map<string, AutoPayoutConfigEntry>([
  [MAX, { value: 30_000, version: 1 }],
  [USER_DAILY, { value: 1, version: 1 }],
]);
const NEW = new Map<string, AutoPayoutConfigEntry>([
  [MAX, { value: 10_000, version: 2 }],
  [USER_DAILY, { value: 3, version: 2 }],
]);

/** Per-key port answering read n (from 1) from the saved state `stateAt(n)`. */
function scriptedPort(stateAt: (read: number) => ReadonlyMap<string, AutoPayoutConfigEntry>) {
  let reads = 0;
  const port: AutoPayoutConfigPort = {
    configValue(_appId, key) {
      reads += 1;
      return Promise.resolve(stateAt(reads).get(key) ?? null);
    },
  };
  return { port, reads: () => reads };
}

it('[AC-B2-11c-UNIT#1] 端口有 configValues 时一次读整组，不逐键读', async () => {
  const calls: (readonly string[])[] = [];
  const port: AutoPayoutConfigPort = {
    configValue: () => Promise.reject(new Error('per-key read')),
    configValues(_appId, keys) {
      calls.push(keys);
      return Promise.resolve(OLD);
    },
  };
  const snapshot = await readAutoPayoutConfigSnapshot(port, HANDLE, APP, KEYS);
  expect(calls).toEqual([KEYS]);
  expect(snapshot.get(MAX)).toEqual({ value: 30_000, version: 1 });
});

it('[AC-B2-11c-UNIT#2] 逐键读到一半批量保存提交：不返回「旧金额上限 + 新次数上限」，重读得新组合', async () => {
  // Read 1 (max) sees the old state, the save commits, read 2 (user_daily) sees the new one.
  const { port, reads } = scriptedPort((read) => (read <= 1 ? OLD : NEW));
  const snapshot = await readAutoPayoutConfigSnapshot(port, HANDLE, APP, KEYS);
  expect([snapshot.get(MAX)?.value, snapshot.get(USER_DAILY)?.value]).toEqual([10_000, 3]);
  expect(reads()).toBe(6);
  const { config, ruleVersion } = autoPayoutConfigOf(snapshot, () => undefined);
  expect(config.max_amount_fen).toBe(10_000n);
  expect(config.user_daily_max_count).toBe(3);
  expect(ruleVersion).toBe(4);
});

it('[AC-B2-11c-UNIT#3] 配置未变时两遍一致即返回，版本和取自同一快照', async () => {
  const { port, reads } = scriptedPort(() => OLD);
  const snapshot = await readAutoPayoutConfigSnapshot(port, HANDLE, APP, KEYS);
  expect(reads()).toBe(4);
  const { config, ruleVersion } = autoPayoutConfigOf(snapshot, () => undefined);
  expect(config.max_amount_fen).toBe(30_000n);
  expect(config.user_daily_max_count).toBe(1);
  expect(ruleVersion).toBe(2);
});

it('[AC-B2-11c-UNIT#4] 配置在每遍之间都在变：读够次数后抛错（事件重试），不拿混合组合判定', async () => {
  // Every pass of two reads flips the saved state, so no two passes agree.
  const { port } = scriptedPort((read) => (Math.floor((read - 1) / 2) % 2 === 0 ? OLD : NEW));
  await expect(readAutoPayoutConfigSnapshot(port, HANDLE, APP, KEYS)).rejects.toThrow(
    'kept changing',
  );
});

it('[AC-B2-11c-UNIT#5] 快照里缺的键取 08 默认值且不计版本；格式不对的键取默认值、计版本并告知', async () => {
  const defaults: string[] = [];
  const snapshot = new Map<string, AutoPayoutConfigEntry>([[MAX, { value: 'x', version: 3 }]]);
  const { config, ruleVersion } = autoPayoutConfigOf(snapshot, (key) => defaults.push(key));
  expect(config).toEqual(AUTO_PAYOUT_DEFAULTS);
  expect(ruleVersion).toBe(3);
  expect(defaults).toEqual([MAX]);
});
