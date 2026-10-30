// B2-04zd（D10-443）：commission 导出 appendBeneficiaryEvent（commission_split_beneficiary_events
// 的单一写者，BR-CALC-13 受益人事件；BR-FUND-04 ⑫）。形状同 settlement credit-order 的
// BeneficiaryEventInput；只追加、写在调用方事务上、created_at 取注入的 Clock。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import type {
  CreditOrderDependencies,
  CreditRole,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { fixture, rows, seed, type Fixture } from '../../commission/snapshot-read/fixtures.ts';
import { NOW, TIMEOUT, databaseFixture, tableCounts } from './kit.ts';

// 经 commission 公开出口运行时加载（不把 Nest 模块图引入测试 tsc）。
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/commission/application/beneficiary-events.ts');

const database = databaseFixture(createTestDatabase);
const LATER = '2032-07-24T00:30:00+08:00';

/** settlement 侧的事件输入类型（credit-order 依赖的第二个参数）。 */
type SettlementEventInput = Parameters<CreditOrderDependencies['appendBeneficiaryEvent']>[1];

function eventInput(
  f: Fixture,
  index: number,
  status: 'held' | 'forfeited',
  reason: 'banned' | 'deleted' | 'minor' | null,
): SettlementEventInput {
  const person = f.people[index]!;
  return {
    appId: f.input.appId,
    orderId: f.input.orderId,
    userId: person.userId,
    role: person.role as CreditRole,
    status,
    reason,
  };
}

/** 在调用方事务里追加；settlement 的输入原样交给 commission 端口（形状一致才能通过 tsc）。 */
async function append(db: Kysely<DB>, input: SettlementEventInput, clock = new FixedClock(NOW)) {
  const write = (trx: Transaction<DB>) => commission.appendBeneficiaryEvent(trx, input, { clock });
  await db.transaction().execute(write);
}

function seqOf(value: unknown): bigint {
  return BigInt(String(value));
}

it(
  '[AC-B2-04zd#16] held 事件追加一行：受益人、角色、状态 held、原因 null，created_at 取注入的 Clock；别的表不写',
  async () => {
    const db = database.db;
    const f = fixture();
    await seed(db, f);
    const before = (await rows(db, f)).events;
    const counts = await tableCounts(db, f.input.appId);

    await append(db, eventInput(f, 1, 'held', null));

    const after = (await rows(db, f)).events;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({
        app_id: f.input.appId,
        order_id: f.input.orderId,
        user_id: f.people[1]!.userId,
        role: f.people[1]!.role,
        status: 'held',
        reason: null,
        created_at: new Date(NOW),
      }),
    ]);
    expect(await tableCounts(db, f.input.appId)).toEqual({
      ...counts,
      commission_split_beneficiary_events: before.length + 1,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#17] forfeited 事件原样记录没收原因（banned / deleted / minor）',
  async () => {
    const db = database.db;
    const f = fixture();
    await seed(db, f);
    const before = (await rows(db, f)).events;

    await append(db, eventInput(f, 0, 'forfeited', 'banned'));
    await append(db, eventInput(f, 1, 'forfeited', 'deleted'));
    await append(db, eventInput(f, 2, 'forfeited', 'minor'));

    const added = (await rows(db, f)).events.slice(before.length);
    expect(added.map((e) => [e.user_id, e.role, e.status, e.reason])).toEqual([
      [f.people[0]!.userId, f.people[0]!.role, 'forfeited', 'banned'],
      [f.people[1]!.userId, f.people[1]!.role, 'forfeited', 'deleted'],
      [f.people[2]!.userId, f.people[2]!.role, 'forfeited', 'minor'],
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#18] 只追加：同一受益人同一角色再追加得到新行，event_seq 递增，已有事件不改不删',
  async () => {
    const db = database.db;
    const f = fixture();
    await seed(db, f);
    const before = (await rows(db, f)).events;

    await append(db, eventInput(f, 0, 'held', null));
    const once = (await rows(db, f)).events;
    await append(db, eventInput(f, 0, 'held', null), new FixedClock(LATER));
    await append(db, eventInput(f, 0, 'forfeited', 'banned'));
    const after = (await rows(db, f)).events;

    expect(after).toHaveLength(before.length + 3);
    expect(after.slice(0, once.length)).toEqual(once);
    const added = after.slice(before.length);
    expect(added.map((e) => [e.user_id, e.role, e.status, e.reason, e.created_at])).toEqual([
      [f.people[0]!.userId, 'self', 'held', null, new Date(NOW)],
      [f.people[0]!.userId, 'self', 'held', null, new Date(LATER)],
      [f.people[0]!.userId, 'self', 'forfeited', 'banned', new Date(NOW)],
    ]);
    const seqs = after.map((e) => seqOf(e.event_seq));
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#19] 写在调用方事务上：事务内可见，调用方回滚后不留行',
  async () => {
    const db = database.db;
    const f = fixture();
    await seed(db, f);
    const before = (await rows(db, f)).events;
    const input = eventInput(f, 2, 'held', null);

    await expect(
      db.transaction().execute(async (trx) => {
        await commission.appendBeneficiaryEvent(trx, input, { clock: new FixedClock(NOW) });
        const inside = await trx
          .withSchema('app')
          .selectFrom('commission_split_beneficiary_events')
          .selectAll()
          .where('app_id', '=', f.input.appId)
          .where('order_id', '=', f.input.orderId)
          .execute();
        expect(inside).toHaveLength(before.length + 1);
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');

    expect((await rows(db, f)).events).toEqual(before);
  },
  TIMEOUT,
);
