// B2-11d: the console's switch write (content/application/kill-switch-admin.ts) asks payout's
// 开启前置检查 through the injected hook (规划/08 BR-WDR-30 细则「开启前置检查」, BR-WDR-17; 编排裁定
// D10-224 ①, D10-392): createKillSwitchAdmin(store, clock, logger, checks) turns
// withdraw.auto_payout.enabled on only when checks.autoPayoutEnable(appId) passes for the caller's
// app; without the hook, or when it does not pass, the write is refused as 20001 [value] with
// nothing written and no alert. Turning it off, and every other switch, never asks. The owner's
// confirmation (BR-WDR-17) stays the console's process; the store here is an in-memory stand-in
// whose transaction keeps its writes only when the work resolves.
import { expect, it, vi } from 'vitest';
import {
  KillSwitchFieldsError,
  createKillSwitchAdmin,
  type KillSwitchActor,
  type KillSwitchAdminChecks,
  type KillSwitchRow,
  type KillSwitchStore,
  type KillSwitchTx,
  type KillSwitchWrite,
} from '../../../../apps/api/src/modules/content/application/kill-switch-admin.ts';

const AUTO = 'withdraw.auto_payout.enabled';
const APP = 'b2-11d-switch-app';
const AT = new Date('2026-10-27T02:00:00.000Z');
const ACTOR: KillSwitchActor = {
  appId: APP,
  adminId: 'admin-b2-11d',
  loginName: 'owner-b2-11d',
  ip: null,
  traceId: 'trace-b2-11d',
};

function memoryStore() {
  let rows = new Map<string, KillSwitchRow>();
  const committed: KillSwitchWrite[] = [];
  const store: KillSwitchStore = {
    rows: () => Promise.resolve([...rows.values()]),
    transaction<T>(work: (tx: KillSwitchTx) => Promise<T>): Promise<T> {
      const staged = new Map(rows);
      const writes: KillSwitchWrite[] = [];
      const tx: KillSwitchTx = {
        lock: (_appId, key) => Promise.resolve(staged.get(key)),
        change(input) {
          const row: KillSwitchRow = {
            key: input.key,
            value: input.value,
            version: (staged.get(input.key)?.version ?? 0) + 1,
            updatedBy: input.actor.loginName,
            updatedAt: input.at,
          };
          staged.set(input.key, row);
          writes.push(input);
          return Promise.resolve(row);
        },
        history: () => Promise.resolve(),
        lockInviteReward: () => Promise.resolve(),
        values: () => Promise.resolve(new Map()),
        audit: () => Promise.resolve(),
      };
      return work(tx).then((result) => {
        rows = staged;
        committed.push(...writes);
        return result;
      });
    },
  };
  return { store, committed, row: (key: string) => rows.get(key) };
}

function admin(checks: KillSwitchAdminChecks) {
  const memory = memoryStore();
  const logger = { warn: vi.fn() };
  const service = createKillSwitchAdmin(memory.store, { now: () => AT }, logger, checks);
  return { service, logger, ...memory };
}

function precheck(passed: boolean) {
  return vi.fn((appId: string) => {
    void appId;
    return Promise.resolve({ passed });
  });
}

async function refusedAsValue(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(KillSwitchFieldsError);
  expect((error as KillSwitchFieldsError).fields).toStrictEqual(['value']);
}

it('[AC-B2-11d#28] 不注入前置检查：后台打开自动到账总开关仍是 20001 [value]，不写、不告警', async () => {
  const a = admin({});
  await refusedAsValue(a.service.update(ACTOR, AUTO, { value: true, expected_version: 0 }));
  expect(a.committed).toStrictEqual([]);
  expect(a.row(AUTO)).toBeUndefined();
  expect(a.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-11d#29] 前置检查不通过：20001 [value]，检查按调用方的 app 问了一次，不写、不告警', async () => {
  const check = precheck(false);
  const a = admin({ autoPayoutEnable: check });
  await refusedAsValue(a.service.update(ACTOR, AUTO, { value: true, expected_version: 0 }));
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(APP);
  expect(a.committed).toStrictEqual([]);
  expect(a.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-11d#30] 前置检查通过：总开关写为 true（version 1），检查按调用方的 app 问了一次', async () => {
  const check = precheck(true);
  const a = admin({ autoPayoutEnable: check });
  const result = await a.service.update(ACTOR, AUTO, { value: true, expected_version: 0 });
  expect(result).toMatchObject({ key: AUTO, value: true, version: 1 });
  expect(a.row(AUTO)).toMatchObject({ key: AUTO, value: true, version: 1 });
  expect(a.committed.map((write) => [write.key, write.value])).toStrictEqual([[AUTO, true]]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(APP);
});

it('[AC-B2-11d#31] 关闭属安全方向：不问前置检查，检查不通过也可以关', async () => {
  const check = precheck(false);
  const a = admin({ autoPayoutEnable: check });
  const result = await a.service.update(ACTOR, AUTO, { value: false, expected_version: 0 });
  expect(result).toMatchObject({ key: AUTO, value: false, version: 1 });
  expect(check).not.toHaveBeenCalled();
  const b = admin({});
  await expect(
    b.service.update(ACTOR, AUTO, { value: false, expected_version: 0 }),
  ).resolves.toMatchObject({ key: AUTO, value: false });
});

it.each([
  { key: 'withdraw.enabled', value: true },
  { key: 'payout.enabled', value: true },
  { key: 'payout.channel_enabled.alipay', value: true },
])(
  '[AC-B2-11d#32] 其余开关 $key 改为 $value：不问前置检查，检查不通过也照常写入',
  async ({ key, value }) => {
    const check = precheck(false);
    const a = admin({ autoPayoutEnable: check });
    const result = await a.service.update(ACTOR, key, { value, expected_version: 0 });
    expect(result).toMatchObject({ key, value, version: 1 });
    expect(check).not.toHaveBeenCalled();
  },
);
