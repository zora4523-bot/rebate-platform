// B2-04zc · BR-TEXT-19：ADMIN_ADJUST / BAD_DEBT_WRITEOFF 只在「无关联单据时」不显示跳转。带订单的
// ADMIN_ADJUST 日常会出现：延后差额补记 ADJ:DEFERRED:RESTORE（settlement 的 beneficiary-credit：
// biz_type ORDER_ADJUST、voucher_kind 沿用开立类型 ADMIN_ADJUST、键 {order_key}:{uid}:{role}:ADJ:
// DEFERRED:{beneficiary_credit_id}）与 BR-FUND-22 R13 恢复（键 {order_key}:{uid}:{role}:RESTORE:
// {差错单 id}），凭证都带 order_key 与受益角色（specs/ledger-templates.csv）。本人 self、share 单上的
// 这类分录跳转到子订单，不 masked；无关联单据的 ADMIN_ADJUST / BAD_DEBT_WRITEOFF 作对照，link 为
// null。期望条目手写，口径同 entries.int.test.ts。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Account } from '../../db/ledger/invariants/kit.ts';
import {
  TIMEOUT,
  clawback,
  counterAccount,
  credit,
  ledger,
  page,
  placed,
  row,
  ruleVersion,
  unlinked,
  withLedger,
  type Ledger,
  type Placed,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let rules: string;
let counter: Account;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  rules = await ruleVersion(db);
  counter = await counterAccount(db);
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

type Origin = 'deferred' | 'r13';

/**
 * 本人在 order 上以 role 受益的一张 ADMIN_ADJUST / RESTORE 凭证（available 子户 +fen，对方平台科目）：
 * deferred 照延后差额补记的写法，r13 照 BR-FUND-22 R13 受益人差额的键。
 */
function restore(
  l: Ledger,
  origin: Origin,
  order: Placed,
  role: 'self' | 'share',
  fen: bigint,
  at: string,
): void {
  const plan: Parameters<Ledger['add']>[0] = {
    uniqKey:
      origin === 'deferred'
        ? `${order.key}:${l.uid}:${role}:ADJ:DEFERRED:${randomUUID()}`
        : `${order.key}:${l.uid}:${role}:RESTORE:${randomUUID()}`,
    bizType: 'ORDER_ADJUST',
    bizId: order.key,
    orderKey: order.key,
    role,
    kind: 'ADMIN_ADJUST',
    at,
    lines: [
      { sub: 'available', type: 'ADMIN_ADJUST', subType: 'RESTORE', delta: fen, counter: true },
    ],
  };
  l.add(plan);
}

it(
  '[AC-B2-04zc#10] BR-TEXT-19 本人自购与分享单上的 ADMIN_ADJUST / RESTORE（R13 恢复、延后差额补记）关联子订单、不 masked；无关联单据的 ADMIN_ADJUST / BAD_DEBT_WRITEOFF 不跳转',
  async () => {
    await withLedger(db, async (r) => {
      const uid = r.me.uid;
      const me = await ledger(db, uid, counter);
      const own = await placed(db, rules, uid, [{ userId: uid, role: 'self', ratioBp: 5000 }]);
      const shared = await placed(
        db,
        rules,
        uid,
        [{ userId: uid, role: 'share', ratioBp: 5000 }],
        'share',
      );
      credit(me, 'REBATE_CREDIT', {
        order: own,
        role: 'self',
        fen: 300n,
        at: '2026-10-01T10:00:00+08:00',
      });
      clawback(me, {
        order: own,
        role: 'self',
        subType: 'FULL',
        fen: -300n,
        at: '2026-10-02T10:00:00+08:00',
      });
      restore(me, 'r13', own, 'self', 300n, '2026-10-03T10:00:00+08:00');
      credit(me, 'SHARE_CREDIT', {
        order: shared,
        role: 'share',
        fen: 200n,
        at: '2026-10-04T10:00:00+08:00',
      });
      clawback(me, {
        order: shared,
        role: 'share',
        subType: 'FULL',
        fen: -200n,
        at: '2026-10-05T10:00:00+08:00',
      });
      restore(me, 'deferred', shared, 'share', 200n, '2026-10-06T10:00:00+08:00');
      restore(me, 'deferred', own, 'self', 50n, '2026-10-07T10:00:00+08:00');
      unlinked(me, 'ADMIN_ADJUST', 'RECON_FIX', -40n, '2026-10-08T10:00:00+08:00');
      unlinked(me, 'BAD_DEBT_WRITEOFF', null, 10n, '2026-10-09T10:00:00+08:00');
      await me.flush();

      const response = await r.get('?limit=50');
      const data = await page(response);
      expect(data).toEqual({
        items: [
          row('BAD_DEBT_WRITEOFF', null, 10, '2026-10-09', 520),
          row('ADMIN_ADJUST', 'RECON_FIX', -40, '2026-10-08', 510),
          row('ADMIN_ADJUST', 'RESTORE', 50, '2026-10-07', 550, ['order', own.id]),
          row('ADMIN_ADJUST', 'RESTORE', 200, '2026-10-06', 500, ['order', shared.id]),
          row('CLAWBACK', 'FULL', -200, '2026-10-05', 300, ['order', shared.id]),
          row('SHARE_CREDIT', null, 200, '2026-10-04', 500, ['order', shared.id]),
          row('ADMIN_ADJUST', 'RESTORE', 300, '2026-10-03', 300, ['order', own.id]),
          row('CLAWBACK', 'FULL', -300, '2026-10-02', 0, ['order', own.id]),
          row('REBATE_CREDIT', null, 300, '2026-10-01', 300, ['order', own.id]),
        ],
        next_cursor: null,
      });
      // 跳转用子订单号（orders.order_id），不是凭证上的 order_key。
      expect(response.body).not.toContain(own.key);
      expect(response.body).not.toContain(shared.key);
    });
  },
  TIMEOUT,
);
