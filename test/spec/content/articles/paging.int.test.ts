// F1-02f ruling 6: keyset pagination by (current published_at DESC, id DESC), a category-bound
// opaque cursor, limit 1–50 with default 20. Microsecond timestamps are written as text so PG keeps
// them; ids from newId() grow in creation order, so id DESC is known in advance.
import { expect, it } from 'vitest';
import {
  at,
  invalid,
  list,
  listAll,
  listRaw,
  newAppId,
  newId,
  seedArticle,
  useHarness,
} from './kit.ts';

const h = useHarness('paging');

/** `ms` from NOW plus `micros` extra microseconds (0–999), as ISO text with six fractional digits. */
function micro(ms: number, micros: number): string {
  return `${at(ms).slice(0, 23)}${String(micros).padStart(3, '0')}Z`;
}

async function seedOrdered(appId: string): Promise<string[]> {
  const hour = 3_600_000;
  const r = newId();
  await seedArticle(h.db, { id: r, appId, category: 'help', publishedAt: at(-20 * hour) });
  // P: v1 is old, v2 (current) is the newest of all, so P sorts by v2's published_at.
  const p = newId();
  await seedArticle(h.db, {
    id: p,
    appId,
    category: 'help',
    version: 1,
    publishedAt: at(-10 * hour),
  });
  await seedArticle(h.db, {
    id: p,
    appId,
    category: 'help',
    version: 2,
    publishedAt: at(-1 * hour),
  });
  const q = newId();
  await seedArticle(h.db, { id: q, appId, category: 'help', publishedAt: at(-5 * hour) });
  // A is one microsecond later than B but has the smaller id: a cursor cut to milliseconds loses B.
  const a = newId();
  const b = newId();
  await seedArticle(h.db, { id: a, appId, category: 'help', publishedAt: micro(-3 * hour, 1) });
  await seedArticle(h.db, { id: b, appId, category: 'help', publishedAt: micro(-3 * hour, 0) });
  // X and Y share the instant exactly: id DESC puts Y first; a time-only cursor loses X.
  const x = newId();
  const y = newId();
  await seedArticle(h.db, { id: x, appId, category: 'help', publishedAt: micro(-2 * hour, 250) });
  await seedArticle(h.db, { id: y, appId, category: 'help', publishedAt: micro(-2 * hour, 250) });
  // Noise that must not appear: other category, draft, other app.
  await seedArticle(h.db, { id: newId(), appId, category: 'rule', publishedAt: at(-1) });
  await seedArticle(h.db, { id: newId(), appId, category: 'help', status: 'draft' });
  await seedArticle(h.db, { id: newId(), appId: newAppId(), category: 'help' });
  return [p, y, x, a, b, q, r];
}

it('[AC-F1-02f#4] one full page lists the current versions by published_at DESC, id DESC', async () => {
  const appId = newAppId();
  const expected = await seedOrdered(appId);
  const page = await list(h, appId, 'help');
  expect(page.items.map((item) => item.article_id)).toEqual(expected);
  expect(page.items[0]!.version).toBe(2);
  expect(page.next_cursor).toBeNull();
});

for (const limit of [1, 2, 3]) {
  it(`[AC-F1-02f#4] paging with limit=${limit} visits every article once, in order, ending with next_cursor null`, async () => {
    const appId = newAppId();
    const expected = await seedOrdered(appId);
    const { ids, pages } = await listAll(h, appId, 'help', limit);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages).toHaveLength(Math.ceil(expected.length / limit));
  });
}

it('[AC-F1-02f#4] the last full page still says next_cursor null when nothing follows', async () => {
  const appId = newAppId();
  const first = newId();
  const second = newId();
  await seedArticle(h.db, { id: first, appId, category: 'rule', publishedAt: at(-2_000) });
  await seedArticle(h.db, { id: second, appId, category: 'rule', publishedAt: at(-1_000) });
  const page = await list(h, appId, 'rule', { limit: 2 });
  expect(page.items.map((item) => item.article_id)).toEqual([second, first]);
  expect(page.next_cursor).toBeNull();
  const one = await list(h, appId, 'rule', { limit: 1 });
  expect(one.items.map((item) => item.article_id)).toEqual([second]);
  expect(typeof one.next_cursor).toBe('string');
});

it('[AC-F1-02f#4] without limit at most 20 items come back; limit=50 returns all 21', async () => {
  const appId = newAppId();
  const ids: string[] = [];
  for (let n = 0; n < 21; n += 1) {
    const id = newId();
    ids.push(id);
    await seedArticle(h.db, {
      id,
      appId,
      category: 'agreement',
      publishedAt: at(-60_000 * (n + 1)),
    });
  }
  const first = await list(h, appId, 'agreement');
  expect(first.items.map((item) => item.article_id)).toEqual(ids.slice(0, 20));
  expect(first.next_cursor).not.toBeNull();
  const rest = await list(h, appId, 'agreement', { cursor: first.next_cursor! });
  expect(rest.items.map((item) => item.article_id)).toEqual(ids.slice(20));
  expect(rest.next_cursor).toBeNull();

  const all = await list(h, appId, 'agreement', { limit: 50 });
  expect(all.items.map((item) => item.article_id)).toEqual(ids);
  expect(all.next_cursor).toBeNull();
});

it('[AC-F1-02f#4] a cursor from another category, or a malformed cursor, is 400 / 20001 with fields [cursor]', async () => {
  const appId = newAppId();
  await seedArticle(h.db, { id: newId(), appId, category: 'help', publishedAt: at(-2_000) });
  await seedArticle(h.db, { id: newId(), appId, category: 'help', publishedAt: at(-1_000) });
  await seedArticle(h.db, { id: newId(), appId, category: 'rule', publishedAt: at(-3_000) });
  const help = await list(h, appId, 'help', { limit: 1 });
  expect(help.next_cursor).not.toBeNull();
  const cursor = help.next_cursor!;

  await invalid(await listRaw(h, appId, 'rule', { cursor }), ['cursor']);
  await invalid(await listRaw(h, appId, 'notice', { cursor }), ['cursor']);
  const garbage = [
    'not-a-cursor!!',
    Buffer.from('null').toString('base64url'),
    Buffer.from('["help"]').toString('base64url'),
    Buffer.from('["help","yesterday","0199f102-f000-7000-8000-000000000001"]').toString(
      'base64url',
    ),
    Buffer.from('["help","2031-03-04T05:06:06.000000Z","not-a-uuid"]').toString('base64url'),
    Buffer.from('{"category":"help"}').toString('base64url'),
  ];
  for (const bad of garbage) {
    await invalid(await listRaw(h, appId, 'help', { cursor: bad }), ['cursor']);
  }
  // The genuine cursor still works on its own category.
  expect((await list(h, appId, 'help', { cursor })).items).toHaveLength(1);
});

it('[AC-F1-02f#4] limit outside 1–50 is 400 / 20001', async () => {
  const appId = newAppId();
  await seedArticle(h.db, { id: newId(), appId, category: 'help' });
  await invalid(await listRaw(h, appId, 'help', { limit: 51 }));
  await invalid(await listRaw(h, appId, 'help', { limit: 0 }));
  expect((await list(h, appId, 'help', { limit: 50 })).items).toHaveLength(1);
});
