// F1-02zn unit tests: the invite reward save guard across the kill-switch and configuration item
// write paths, over one in-memory store whose transactions commit at the end and whose campaign
// lock is a real mutex (READ COMMITTED reads of committed rows, as in PostgreSQL).
import { expect, it } from 'vitest';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  ConfigItemAdmin,
  ConfigItemFieldsError,
  type ConfigItemActor,
  type ConfigItemRow,
  type ConfigItemStore,
  type ConfigItemTx,
  type ConfigItemWrite,
} from './config-item-admin.ts';
import {
  KillSwitchAdmin,
  KillSwitchFieldsError,
  type KillSwitchStore,
  type KillSwitchTx,
} from './kill-switch-admin.ts';

const AT = new Date('2026-10-01T00:00:00.000Z');
const clock: Clock = { now: () => AT } as Clock;
const actor: ConfigItemActor = {
  appId: 'couli',
  adminId: 'admin-1',
  loginName: 'ops',
  ip: null,
  traceId: 'trace-1',
};
const ENABLED = 'growth.invite_reward.enabled';
const PAUSED = 'growth.invite_reward.payout_paused';
const AMOUNT = 'growth.invite_reward.amount_fen';
const DAILY = 'growth.invite_reward.daily_budget_fen';
const TOTAL = 'growth.invite_reward.total_budget_fen';
const MIN_PAID = 'growth.invite_reward.min_paid_fen';
const WINDOW = 'growth.invite_reward.ip_window_hours';
const GUARDED = [AMOUNT, DAILY, TOTAL] as const;

type Json = ConfigItemRow['value'];
type Row = { key: string; value: Json; version: number; updatedBy: string; updatedAt: Date };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class Memory {
  readonly rows = new Map<string, Row>();
  readonly history = new Map<string, Json>();
  readonly audits: AuditInput[] = [];
  readonly alerts: unknown[] = [];
  readonly events: string[] = [];
  readonly #realLock: boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(realLock = true) {
    this.#realLock = realLock;
  }

  put(key: string, value: Json, version = 1): void {
    this.rows.set(key, { key, value, version, updatedBy: 'seed', updatedAt: AT });
  }

  async transaction<T>(work: (tx: ConfigItemTx & KillSwitchTx) => Promise<T>): Promise<T> {
    const pending = new Map<string, Row>();
    const audits: AuditInput[] = [];
    const history = new Map<string, Json>();
    let release: (() => void) | undefined;
    const read = (key: string) => pending.get(key) ?? this.rows.get(key);
    const tx: ConfigItemTx & KillSwitchTx = {
      lockInviteReward: async () => {
        this.events.push('lock');
        if (!this.#realLock || release !== undefined) return;
        const previous = this.#tail;
        this.#tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
      },
      lock: async (_app, key) => {
        await tick();
        this.events.push(`row:${key}`);
        return read(key);
      },
      values: async (_app, keys) => {
        await tick();
        this.events.push(`read:${keys.join(',')}`);
        const found = new Map<string, Json>();
        for (const key of keys) {
          const row = read(key);
          if (row !== undefined) found.set(key, row.value);
        }
        return found;
      },
      version: async (_app, key, version) => {
        await tick();
        const id = `${key}@${version}`;
        return this.history.has(id) ? { value: this.history.get(id)! } : undefined;
      },
      change: async (input: ConfigItemWrite) => {
        await tick();
        const current = read(input.key);
        if ((current?.version ?? 0) !== input.expectedVersion) return undefined;
        const row = {
          key: input.key,
          value: input.value,
          version: input.expectedVersion + 1,
          updatedBy: input.actor.loginName,
          updatedAt: input.at,
        };
        pending.set(input.key, row);
        return row;
      },
      history: async (input, version) => {
        history.set(`${input.key}@${version}`, input.value);
      },
      audit: async (input) => {
        audits.push(input);
      },
    };
    try {
      const result = await work(tx);
      await tick();
      for (const [key, row] of pending) {
        // A lost version race at commit time is the unique key / conditional UPDATE failing.
        if ((this.rows.get(key)?.version ?? 0) !== row.version - 1) {
          throw new Error('serialization');
        }
      }
      for (const [key, row] of pending) this.rows.set(key, row);
      for (const [id, value] of history) this.history.set(id, value);
      this.audits.push(...audits);
      return result;
    } finally {
      release?.();
    }
  }

  configAdmin(): ConfigItemAdmin {
    const store: ConfigItemStore = {
      rows: () => Promise.resolve([...this.rows.values()]),
      row: (_app, key) => Promise.resolve(this.rows.get(key)),
      versions: () => Promise.reject(new Error('unused')),
      transaction: (work) => this.transaction(work),
    };
    return new ConfigItemAdmin(store, clock, { warn: (obj: unknown) => this.alerts.push(obj) });
  }

  switchAdmin(): KillSwitchAdmin {
    const store: KillSwitchStore = {
      rows: () => Promise.resolve([...this.rows.values()]),
      transaction: (work) => this.transaction(work),
    };
    return new KillSwitchAdmin(store, clock, { warn: (obj: unknown) => this.alerts.push(obj) });
  }

  snapshot(): string {
    return JSON.stringify({
      rows: [...this.rows.entries()],
      history: [...this.history.entries()],
      audits: this.audits.length,
      alerts: this.alerts.length,
    });
  }
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => null,
    (caught: unknown) => caught,
  );
}

async function refusedFields(work: Promise<unknown>): Promise<readonly string[]> {
  const error = await failure(work);
  expect(error instanceof ConfigItemFieldsError || error instanceof KillSwitchFieldsError).toBe(
    true,
  );
  return (error as ConfigItemFieldsError).fields;
}

function positive(memory: Memory, except?: string): void {
  for (const key of GUARDED) if (key !== except) memory.put(key, 100);
}

const open = (memory: Memory, expected = 0) =>
  memory.switchAdmin().update(actor, ENABLED, { value: true, expected_version: expected });

it.each([
  ...GUARDED.flatMap((key) =>
    [undefined, 0, -1, 1.5, '100', null, true].map((value) => ({ key, value })),
  ),
])(
  '[AC-F1-02zn#8] 单元：开启时 $key=$value（undefined 即缺行）拒绝 [value]，无写入与告警',
  async ({ key, value }) => {
    const memory = new Memory();
    positive(memory, key);
    if (value !== undefined) memory.put(key, value as Json);
    const before = memory.snapshot();
    expect(await refusedFields(open(memory))).toStrictEqual(['value']);
    expect(memory.snapshot()).toBe(before);
  },
);

it('[AC-F1-02zn#7] 单元：三项都为正整数（1 分即可）时开启成功，并按完整键名读取', async () => {
  const memory = new Memory();
  for (const key of GUARDED) memory.put(key, 1);
  const result = await open(memory);
  expect(result).toMatchObject({ key: ENABLED, value: true, version: 1 });
  expect(memory.rows.get(ENABLED)?.value).toBe(true);
  expect(memory.alerts).toHaveLength(1);
  // Lock before the row lock, and read the three full keys under it.
  expect(memory.events).toStrictEqual(['lock', `row:${ENABLED}`, `read:${GUARDED.join(',')}`]);
});

it('[AC-F1-02zn#12] 单元：关闭 enabled、开关 payout_paused 不校验也不取锁', async () => {
  const memory = new Memory();
  memory.put(ENABLED, true);
  const admin = memory.switchAdmin();
  await admin.update(actor, ENABLED, { value: false, expected_version: 1 });
  await admin.update(actor, PAUSED, { value: true, expected_version: 0 });
  await admin.update(actor, PAUSED, { value: false, expected_version: 1 });
  expect(memory.rows.get(ENABLED)?.value).toBe(false);
  expect(memory.rows.get(PAUSED)).toMatchObject({ value: false, version: 2 });
  expect(memory.events.filter((event) => event === 'lock' || event.startsWith('read:'))).toEqual(
    [],
  );
});

it('[AC-F1-02zn#7] 单元：已开启时同值写 true 是无变化，不重新校验', async () => {
  const memory = new Memory();
  memory.put(ENABLED, true);
  const result = await open(memory, 1);
  expect(result).toMatchObject({ value: true, version: 1 });
  expect(memory.alerts).toStrictEqual([]);
});

it.each(GUARDED)('[AC-F1-02zn#9] 单元：on 时 PUT %s=0 拒绝 [value]，无写入', async (key) => {
  const memory = new Memory();
  positive(memory);
  memory.put(ENABLED, true);
  const before = memory.snapshot();
  expect(
    await refusedFields(memory.configAdmin().update(actor, key, { value: 0, expected_version: 1 })),
  ).toStrictEqual(['value']);
  expect(memory.snapshot()).toBe(before);
});

it.each(GUARDED)('[AC-F1-02zn#9] 单元：on 时 batch 把 %s 置零，整批拒绝且不写', async (key) => {
  const memory = new Memory();
  positive(memory);
  memory.put(ENABLED, true);
  const before = memory.snapshot();
  const items = [
    { key: 'withdraw.payout_account_verify_per_day', value: 4, expected_version: 0 },
    ...GUARDED.map((guarded) => ({
      key: guarded,
      value: guarded === key ? 0 : 101,
      expected_version: 1,
    })),
  ];
  expect(await refusedFields(memory.configAdmin().batch(actor, { items }))).toStrictEqual([key]);
  expect(memory.snapshot()).toBe(before);
});

it('[AC-F1-02zn#9] 单元：on 时 batch 同时置零多个受保护键，fields 按请求顺序列出', async () => {
  const memory = new Memory();
  positive(memory);
  memory.put(ENABLED, true);
  const items = [TOTAL, AMOUNT].map((key) => ({ key, value: 0, expected_version: 1 }));
  expect(await refusedFields(memory.configAdmin().batch(actor, { items }))).toStrictEqual([
    TOTAL,
    AMOUNT,
  ]);
});

it.each(GUARDED)(
  '[AC-F1-02zn#9] 单元：on 时 rollback %s 到值为 0 的版本拒绝 [to_version]',
  async (key) => {
    const memory = new Memory();
    positive(memory, key);
    memory.put(key, 100, 2);
    memory.history.set(`${key}@1`, 0);
    memory.put(ENABLED, true);
    const before = memory.snapshot();
    expect(
      await refusedFields(
        memory.configAdmin().rollback(actor, key, { to_version: 1, expected_version: 2 }),
      ),
    ).toStrictEqual(['to_version']);
    expect(memory.snapshot()).toBe(before);
  },
);

it.each(GUARDED)('[AC-F1-02zn#10] 单元：off（含缺行与非 true 值）时 %s 可写 0', async (key) => {
  for (const enabled of [undefined, false, 'true', 1] as const) {
    const memory = new Memory();
    memory.put(key, 100, 2);
    memory.history.set(`${key}@1`, 0);
    if (enabled !== undefined) memory.put(ENABLED, enabled);
    const admin = memory.configAdmin();
    await admin.update(actor, key, { value: 0, expected_version: 2 });
    await admin.batch(actor, { items: [{ key, value: 5, expected_version: 3 }] });
    await admin.batch(actor, { items: [{ key, value: 0, expected_version: 4 }] });
    await admin.rollback(actor, key, { to_version: 1, expected_version: 5 });
    expect(memory.rows.get(key)).toMatchObject({ value: 0, version: 6 });
  }
});

it('[AC-F1-02zn#13] 单元：on 时正数改值、min_paid=0、ip_window=1 不取锁不被挡', async () => {
  const memory = new Memory();
  for (const key of GUARDED) memory.put(key, 1);
  memory.put(ENABLED, true);
  const admin = memory.configAdmin();
  for (const key of GUARDED) await admin.update(actor, key, { value: 2, expected_version: 1 });
  await admin.update(actor, MIN_PAID, { value: 0, expected_version: 0 });
  await admin.update(actor, WINDOW, { value: 1, expected_version: 0 });
  await admin.batch(actor, { items: [{ key: MIN_PAID, value: 0, expected_version: 1 }] });
  expect(memory.events).not.toContain('lock');
  expect(memory.rows.get(TOTAL)).toMatchObject({ value: 2, version: 2 });
});

it('[AC-F1-02zn#16] 单元：越界值在事务前以 20001 拒绝，不取锁', async () => {
  const memory = new Memory();
  const admin = memory.configAdmin();
  expect(
    await refusedFields(admin.update(actor, AMOUNT, { value: -1, expected_version: 0 })),
  ).toStrictEqual(['value']);
  expect(
    await refusedFields(admin.update(actor, WINDOW, { value: 0, expected_version: 0 })),
  ).toStrictEqual(['value']);
  expect(memory.events).toStrictEqual([]);
});

const races = GUARDED.flatMap((key) =>
  (['update', 'batch', 'rollback'] as const).flatMap((operation) =>
    [false, true].map((zeroFirst) => ({ key, operation, zeroFirst })),
  ),
);

function zero(memory: Memory, key: string, operation: 'update' | 'batch' | 'rollback') {
  const admin = memory.configAdmin();
  if (operation === 'batch') {
    return admin.batch(actor, { items: [{ key, value: 0, expected_version: 2 }] });
  }
  if (operation === 'rollback') {
    return admin.rollback(actor, key, { to_version: 1, expected_version: 2 });
  }
  return admin.update(actor, key, { value: 0, expected_version: 2 });
}

function raceFixture(key: string, realLock = true): Memory {
  const memory = new Memory(realLock);
  positive(memory, key);
  memory.put(key, 100, 2);
  memory.history.set(`${key}@1`, 0);
  return memory;
}

it.each(races)(
  '[AC-F1-02zn#17] 单元：并发开启与 $operation $key=0（置零先发=$zeroFirst）恰一方成功',
  async ({ key, operation, zeroFirst }) => {
    const memory = raceFixture(key);
    const [first, second] = zeroFirst
      ? [zero(memory, key, operation), open(memory)]
      : [open(memory), zero(memory, key, operation)];
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toStrictEqual([
      'fulfilled',
      'rejected',
    ]);
    const enabled = memory.rows.get(ENABLED)?.value === true;
    const zeroed = memory.rows.get(key)?.value === 0;
    expect(enabled && zeroed).toBe(false);
    expect(enabled || zeroed).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(
          outcome.reason instanceof ConfigItemFieldsError ||
            outcome.reason instanceof KillSwitchFieldsError,
        ).toBe(true);
      }
    }
    expect(memory.audits).toHaveLength(1);
  },
);

it('[AC-F1-02zn#17] 单元：对照——没有共享锁时同一交错会双双成功（证明上组用例确实依赖锁）', async () => {
  const memory = raceFixture(TOTAL, false);
  const outcomes = await Promise.allSettled([open(memory), zero(memory, TOTAL, 'update')]);
  expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(['fulfilled', 'fulfilled']);
  expect(memory.rows.get(ENABLED)?.value).toBe(true);
  expect(memory.rows.get(TOTAL)?.value).toBe(0);
});
