// B2-08d (task §9.1 顺序与分页, §9.3 分页): the tax export pages by (paid_at ASC, id ASC) with an
// opaque base64url cursor; next_cursor null = done; limit default 500, at most 1000 (an integer
// 1..1000, anything else refused with TaxExportBadLimit); a cursor the port did not issue is refused
// with TaxExportBadCursor. Real PostgreSQL (the global setup provisions it), run only in the
// orchestrator's isolated container. The reader is created inside each test before anything is
// seeded, so a skeleton fails per test with NotImplemented.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createTaxExportReader,
  TaxExportBadCursor,
  TaxExportBadLimit,
  type TaxExportPage,
  type TaxExportQuery,
  type TaxExportRead,
} from '../../../../apps/api/src/modules/payout/index.ts';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  TIMEOUT,
  close,
  fakeDecrypt,
  ids,
  inExportOrder,
  member,
  open,
  seedMany,
  seedWithdrawal,
  type Harness,
  type WithdrawalRow,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const QUARTER = '2026-Q4';
const Q4_START_MS = Date.parse('2026-10-01T00:00:00.000+08:00');
const SECOND = 1_000;

/** An instant `seconds` after the Q4 start (+08:00). */
function q4(seconds: number): Date {
  return new Date(Q4_START_MS + seconds * SECOND);
}

/** The query with the cursor when there is one (exactOptionalPropertyTypes). */
function query(appId: string, cursor: string | null, limit?: number): TaxExportQuery {
  return {
    appId,
    quarter: QUARTER,
    ...(cursor === null ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Every page from the first to the one whose next_cursor is null (at most `guard` pages). */
async function walk(
  read: TaxExportRead,
  handle: Kysely<DB>,
  appId: string,
  limit: number | undefined,
  guard = 50,
): Promise<TaxExportPage[]> {
  const pages: TaxExportPage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < guard; i += 1) {
    const page = await read(handle, query(appId, cursor, limit));
    pages.push(page);
    if (page.next_cursor === null) return pages;
    cursor = page.next_cursor;
  }
  throw new Error(`walk: no last page after ${guard} pages`);
}

function allIds(pages: readonly TaxExportPage[]): string[] {
  return pages.flatMap((page) => ids(page.items));
}

function orderedIds(rows: readonly WithdrawalRow[]): string[] {
  return inExportOrder(rows).map((row) => row.id);
}

/** Seven paid rows of Q4 with ties on paid_at (the id breaks them). */
async function sevenRows(who: { appId: string; userId: string }): Promise<WithdrawalRow[]> {
  return seedMany(h.db, who, [
    { paid_at: q4(300) },
    { paid_at: q4(100), status: 'PAID_MANUAL' },
    { paid_at: q4(200) },
    { paid_at: q4(200), status: 'PAID_MANUAL' },
    { paid_at: q4(200) },
    { paid_at: q4(50) },
    { paid_at: q4(300) },
  ]);
}

it(
  '[AC-B2-08d#8] 顺序 paid_at ASC、id ASC（同到账时间按 id）；与插入顺序无关',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const rows = await sevenRows(who);
    const page = await read(h.db, query(who.appId, null));
    expect(ids(page.items)).toEqual(orderedIds(rows));
    expect(page.next_cursor).toBeNull();
    const times = page.items.map((item) => item.paid_at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  },
  TIMEOUT,
);

it.each([1, 2, 3, 6, 7, 8])(
  '[AC-B2-08d#9] limit %i：按 limit 切片，游标续页不重不漏；满页才有游标，不满一页的页 next_cursor 为 null；游标是 base64url',
  async (limit) => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const rows = await sevenRows(who);
    const pages = await walk(read, h.db, who.appId, limit);
    expect(allIds(pages)).toEqual(orderedIds(rows));
    expect(new Set(allIds(pages)).size).toBe(rows.length);
    for (const page of pages.slice(0, -1)) {
      expect(page.items).toHaveLength(limit);
      expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    const last = pages.at(-1);
    expect(last?.next_cursor).toBeNull();
    // A page with fewer than `limit` rows is the last one.
    for (const page of pages) {
      if (page.items.length < limit) expect(page.next_cursor).toBeNull();
    }
    // 7 rows: ceil(7 / limit) pages, or one more (empty) when the last full page cannot tell.
    const full = Math.ceil(rows.length / limit);
    expect([full, full + (rows.length % limit === 0 ? 1 : 0)]).toContain(pages.length);
    if (limit === 3) expect(pages.map((page) => page.items.length)).toEqual([3, 3, 1]);
    if (limit === 8) expect(pages.map((page) => page.items.length)).toEqual([7]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#10] 游标是位置不是偏移：翻页之间补进更早到账的单不会让下一页重复，补进更晚到账的单在后面出现',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const rows = await seedMany(
      h.db,
      who,
      [1, 2, 3, 4, 5, 6].map((n) => ({ paid_at: q4(n * 3_600) })),
    );
    const ordered = inExportOrder(rows);
    const first = await read(h.db, query(who.appId, null, 3));
    expect(ids(first.items)).toEqual(ordered.slice(0, 3).map((row) => row.id));
    expect(first.next_cursor).not.toBeNull();
    const earlier = await seedWithdrawal(h.db, who, { paid_at: q4(60) });
    const later = await seedWithdrawal(h.db, who, { paid_at: q4(7 * 3_600) });
    const rest: string[] = [];
    let cursor = first.next_cursor;
    for (let i = 0; cursor !== null && i < 10; i += 1) {
      const page = await read(h.db, query(who.appId, cursor, 3));
      rest.push(...ids(page.items));
      cursor = page.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(rest).toEqual([...ordered.slice(3).map((row) => row.id), later.id]);
    expect(rest).not.toContain(earlier.id);
    // A fresh walk sees everything, the earlier row first.
    const fresh = allIds(await walk(read, h.db, who.appId, 3));
    expect(fresh).toEqual([earlier.id, ...ordered.map((row) => row.id), later.id]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#11] limit 缺省 500、上限 1000：1001 张单 → 缺省首页 500 张带游标；limit 1000 首页 1000 张带游标、次页 1 张为 null；两种翻法内容相同',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const total = MAX_LIMIT + 1;
    const patches = Array.from({ length: total }, (_unused, n) => ({
      // Pairs share a paid_at, so ties cross the page edges too.
      paid_at: q4(Math.floor(n / 2)),
      status: n % 3 === 0 ? 'PAID_MANUAL' : 'PAID_API',
    }));
    const rows = await seedMany(h.db, who, patches);
    expect(rows).toHaveLength(total);
    const expected = orderedIds(rows);
    const byDefault = await walk(read, h.db, who.appId, undefined);
    expect(byDefault.map((page) => page.items.length)).toEqual([
      DEFAULT_LIMIT,
      DEFAULT_LIMIT,
      total - 2 * DEFAULT_LIMIT,
    ]);
    expect(byDefault[0]?.next_cursor).not.toBeNull();
    expect(allIds(byDefault)).toEqual(expected);
    const byMax = await walk(read, h.db, who.appId, MAX_LIMIT);
    expect(byMax.map((page) => page.items.length)).toEqual([MAX_LIMIT, 1]);
    expect(byMax[0]?.next_cursor).not.toBeNull();
    expect(byMax[1]?.next_cursor).toBeNull();
    expect(allIds(byMax)).toEqual(expected);
  },
  TIMEOUT,
);

it.each([0, -1, 1.5, MAX_LIMIT + 1, 5_000, Number.NaN, Number.POSITIVE_INFINITY])(
  '[AC-B2-08d#12] 非法 limit %d（不是 1..1000 的整数）→ TaxExportBadLimit',
  async (limit) => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    await seedWithdrawal(h.db, who, { paid_at: q4(10) });
    let thrown: unknown = null;
    try {
      await read(h.db, query(who.appId, null, limit));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaxExportBadLimit);
    expect(decrypt.calls).toEqual([]);
  },
  TIMEOUT,
);

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

const BAD_CURSORS = [
  { name: '非 base64url 字符', cursor: 'not a cursor!' },
  { name: '标点', cursor: '!!!!' },
  { name: '任意文本', cursor: base64url('hello') },
  { name: 'id 不是 uuid', cursor: base64url('2026-10-01T00:00:00.000Z:not-a-uuid') },
  { name: '时间不是时间', cursor: base64url(`not-a-date:${randomUUID()}`) },
  { name: '没有时间', cursor: base64url(`:${randomUUID()}`) },
  { name: '只有 uuid', cursor: base64url(randomUUID()) },
] as const;

it.each(BAD_CURSORS)(
  '[AC-B2-08d#13] 非法游标（$name）→ TaxExportBadCursor；同一读端口自己发的游标照常续页',
  async ({ cursor }) => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const rows = await seedMany(h.db, who, [{ paid_at: q4(10) }, { paid_at: q4(20) }]);
    let thrown: unknown = null;
    try {
      await read(h.db, query(who.appId, cursor));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TaxExportBadCursor);
    const first = await read(h.db, query(who.appId, null, 1));
    expect(first.next_cursor).not.toBeNull();
    const second = await read(h.db, query(who.appId, first.next_cursor, 1));
    expect([...ids(first.items), ...ids(second.items)]).toEqual(orderedIds(rows));
  },
  TIMEOUT,
);
