// B2-04zc · BR-FUND-15：余额流水按时间倒序（记账时刻，不是插入顺序），cursor + limit 翻页不重不漏
// （同一时刻的多条跨页、翻页之间又记了新分录），只读本人、未登录拒绝、读取不写库。期望条目手写，
// 约定同 entries.int.test.ts。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Account } from '../../db/ledger/invariants/kit.ts';
import {
  TIMEOUT,
  counterAccount,
  credit,
  everything,
  footprint,
  ledger,
  page,
  paidRow,
  placed,
  refused,
  row,
  ruleVersion,
  unlinked,
  walk,
  withLedger,
  withdraw,
  type Entry,
  type Person,
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

function self(userId: string): Person[] {
  return [{ userId, role: 'self', ratioBp: 5000 }];
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

it(
  '[AC-B2-04zc#6] BR-FUND-15 按记账时刻倒序（与写入顺序无关）：跨午夜的分录各归其会计日，汇总条目按打款成功时刻排进分录之间',
  async () => {
    await withLedger(db, async (r) => {
      const uid = r.me.uid;
      const me = await ledger(db, uid, counter);
      const a = await placed(db, rules, uid, self(uid));
      const b = await placed(db, rules, uid, self(uid));
      const c = await placed(db, rules, uid, self(uid));
      const d = await placed(db, rules, uid, self(uid));
      const rebate = (order: typeof a, fen: bigint, at: string) =>
        credit(me, 'REBATE_CREDIT', { order, role: 'self', fen, at });
      // 写入顺序：a、b、提现（冻结、打款）、c、d；时间顺序：b、冻结、a、d、c、打款。
      rebate(a, 100n, '2026-10-20T10:00:00+08:00');
      rebate(b, 200n, '2026-10-18T10:00:00+08:00');
      const w = await withdraw(db, me, {
        status: 'PAID_API',
        amount: 150n,
        tax: 5n,
        appliedAt: '2026-10-19T09:00:00+08:00',
        settledAt: '2026-10-21T00:00:30+08:00',
      });
      rebate(c, 300n, '2026-10-21T00:00:00+08:00');
      rebate(d, 400n, '2026-10-20T23:59:59+08:00');
      await me.flush();

      expect(await everything(r)).toEqual([
        paidRow(w, 145, 0, 5, '2026-10-21'),
        row('REBATE_CREDIT', null, 300, '2026-10-21', 850, ['order', c.id]),
        row('REBATE_CREDIT', null, 400, '2026-10-20', 550, ['order', d.id]),
        row('REBATE_CREDIT', null, 100, '2026-10-20', 150, ['order', a.id]),
        row('WITHDRAW_FREEZE', null, -150, '2026-10-19', 50, ['withdrawal', w]),
        row('REBATE_CREDIT', null, 200, '2026-10-18', 200, ['order', b.id]),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#7] BR-FUND-15 cursor + limit 翻页不重不漏：缺省每页 20、上限 50；同一时刻的 6 条（含汇总条目）跨页不丢；翻页之间新记的分录不让后续页重复',
  async () => {
    await withLedger(db, async (r) => {
      const me = await ledger(db, r.me.uid, counter);
      const adjust = (fen: bigint, at: string) => unlinked(me, 'ADMIN_ADJUST', 'OTHER', fen, at);
      for (let k = 1; k <= 12; k += 1) adjust(100n, `2026-10-${pad(k)}T10:00:00+08:00`);
      const same = '2026-10-14T10:00:00+08:00';
      const w = await withdraw(db, me, {
        status: 'PAID_API',
        amount: 500n,
        appliedAt: '2026-10-13T10:00:00+08:00',
        settledAt: same,
      });
      for (const fen of [1n, 2n, 3n, 4n, 5n]) adjust(fen, same);
      for (let k = 15; k <= 18; k += 1) adjust(100n, `2026-10-${pad(k)}T10:00:00+08:00`);
      await me.flush();

      const other = (amount: number, date: string, after: number) =>
        row('ADMIN_ADJUST', 'OTHER', amount, date, after);
      const newer = [18, 17, 16, 15].map((day) =>
        other(100, `2026-10-${pad(day)}`, 815 + (day - 15) * 100),
      );
      const tie: Entry[] = [
        paidRow(w, 500, 0, 0, '2026-10-14'),
        other(1, '2026-10-14', 701),
        other(2, '2026-10-14', 703),
        other(3, '2026-10-14', 706),
        other(4, '2026-10-14', 710),
        other(5, '2026-10-14', 715),
      ];
      const older = [
        row('WITHDRAW_FREEZE', null, -500, '2026-10-13', 700, ['withdrawal', w]),
        ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((day) =>
          other(100, `2026-10-${pad(day)}`, day * 100),
        ),
      ];
      const byAmount = (items: Entry[]) => [...items].sort((x, y) => x.amount_fen - y.amount_fen);

      const full = await everything(r);
      expect(full).toHaveLength(23);
      expect(full.slice(0, 4)).toEqual(newer);
      // 同一时刻的 6 条之间的先后由实现决定，但每次读取必须一致（下面逐页比对整表）。
      expect(byAmount(full.slice(4, 10))).toEqual(byAmount(tie));
      expect(full.slice(10)).toEqual(older);

      const first = await page(await r.get());
      expect(first.items).toEqual(full.slice(0, 20));
      expect(first.next_cursor).not.toBeNull();

      for (const limit of [1, 2, 3, 5, 6, 7, 22, 23, 50]) {
        const walked = await walk(r, limit);
        expect(walked.items, `limit=${limit}`).toEqual(full);
        const least = Math.ceil(full.length / limit);
        expect(walked.pages, `limit=${limit}`).toBeGreaterThanOrEqual(least);
        expect(walked.pages, `limit=${limit}`).toBeLessThanOrEqual(least + 1);
      }

      // 第一页读完后又记了一笔更新的分录：沿原游标继续读，既不重复也不遗漏原有的条目。
      const head = await page(await r.get('?limit=5'));
      expect(head.items).toEqual(full.slice(0, 5));
      expect(head.next_cursor).not.toBeNull();
      adjust(100n, '2026-10-19T10:00:00+08:00');
      await me.flush();
      const rest = await walk(r, 5, head.next_cursor);
      expect([...head.items, ...rest.items]).toEqual(full);
      expect(await everything(r)).toEqual([other(100, '2026-10-19', 1215), ...full]);

      for (const limit of ['0', '51']) await refused(await r.get(`?limit=${limit}`), 400, 20001);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zc#8] BR-FUND-15 只读本人：别人的分录与游标都读不到本人的条目、没有分录时为空列表；未登录 401 / 10001；读取不写库',
  async () => {
    await withLedger(db, async (r) => {
      const uid = r.me.uid;
      const me = await ledger(db, uid, counter);
      const earlier = await placed(db, rules, uid, self(uid));
      const later = await placed(db, rules, uid, self(uid));
      credit(me, 'REBATE_CREDIT', {
        order: earlier,
        role: 'self',
        fen: 42n,
        at: '2026-10-30T10:00:00+08:00',
      });
      credit(me, 'REBATE_CREDIT', {
        order: later,
        role: 'self',
        fen: 8n,
        at: '2026-10-30T12:00:00+08:00',
      });
      await me.flush();
      await (await ledger(db, r.someone.uid, counter)).flush();
      const stranger = await ledger(db, randomUUID(), counter);
      unlinked(stranger, 'ADMIN_ADJUST', 'OTHER', 999n, '2026-10-30T11:00:00+08:00');
      await stranger.flush();
      const before = await footprint(db);

      expect(await everything(r)).toEqual([
        row('REBATE_CREDIT', null, 8, '2026-10-30', 50, ['order', later.id]),
        row('REBATE_CREDIT', null, 42, '2026-10-30', 42, ['order', earlier.id]),
      ]);
      for (const query of ['', '?limit=1', '?limit=50']) {
        expect(await page(await r.get(query, r.someone)), query).toEqual({
          items: [],
          next_cursor: null,
        });
      }
      // 本人的游标交给别人：要么拒绝，要么只给对方自己的（空）流水，绝不带出本人的条目。
      const head = await page(await r.get('?limit=1'));
      expect(head.items).toEqual([
        row('REBATE_CREDIT', null, 8, '2026-10-30', 50, ['order', later.id]),
      ]);
      expect(head.next_cursor).not.toBeNull();
      const borrowed = await r.get(
        `?limit=1&cursor=${encodeURIComponent(head.next_cursor ?? '')}`,
        r.someone,
      );
      expect([200, 400]).toContain(borrowed.statusCode);
      expect(borrowed.body).not.toContain(earlier.id);
      expect(borrowed.body).not.toContain(later.id);

      const anonymous = await r.get('', null);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 10001 });
      expect(anonymous.json()).not.toHaveProperty('data.items');
      expect(await footprint(db)).toEqual(before);
    });
  },
  TIMEOUT,
);
