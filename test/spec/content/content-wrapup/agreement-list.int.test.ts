// F1-02z §9.2#2 / §9.3#3–4: no sleeps, races, or frozen fixture imports.
import { expect, it } from 'vitest';
import { list, setup, success, useHarness, type Page } from './kit.ts';
import { insertAgreement, observeList } from './list-snapshot.ts';

const h = useHarness(() => import('@couli/db/testing'));

it('[AC-F1-02z#2] 协议列表两次读共享只读 RR 快照，第二次读前并发首发不混页，总数不丢失', async () => {
  // Exercise the observer's one-statement path: it must return without waiting for a
  // nonexistent second query, and it must not inject a write after the first result.
  const single = await setup(h);
  const once = await observeList(
    h,
    single,
    () => insertAgreement(h, single),
    async (_app, db) => {
      return db.selectFrom('agreements').where('app_id', '=', single.appId).selectAll().execute();
    },
  );
  expect(once.result).toEqual([]);
  expect(once.readCount).toBe(1);
  expect(once.injections).toBe(0);

  // Nonempty and out-of-range controls also catch count(*) OVER() losing total on no rows.
  const seeded = await setup(h);
  await insertAgreement(h, seeded);
  const full = await success<Page>(await list(seeded, '?page_size=100'), 'list');
  expect(full.items).toHaveLength(1);
  expect(full.total).toBe(1);
  const beyond = await success<Page>(await list(seeded, '?page=999&page_size=100'), 'list');
  expect(beyond).toMatchObject({ items: [], total: 1, page: 999, page_size: 100 });

  const f = await setup(h);
  const observed = await observeList(
    h,
    f,
    () => insertAgreement(h, f),
    async (app) => {
      return success<Page>(await list({ app, token: f.token }, '?page_size=100'), 'list');
    },
  );
  expect(observed.readCount).toBe(2);
  expect(observed.injections).toBe(1);
  const page = observed.result;
  expect(page.items.length, 'items and total must describe the same database snapshot').toBe(
    page.total,
  );
  expect(page).toMatchObject({ items: [], total: 0 });
  expect(observed.parallel, 'issue the second SELECT only after the first has completed').toBe(
    false,
  );
  expect(observed.pending).toBe(0);
  expect(observed.observations).toHaveLength(2);
  const transaction = observed.observations[0]!.transaction;
  expect(transaction, 'both reads must be inside a transaction').toBeGreaterThan(0);
  for (const read of observed.observations) {
    expect(read).toEqual({
      transaction,
      mode: { isolation: 'repeatable read', read_only: 'on' },
    });
  }
  expect(observed.statements.filter((statement) => /^commit\b/i.test(statement))).toHaveLength(1);
  // The writer did commit, and the next request takes a new snapshot.
  const next = await success<Page>(await list(f, '?page_size=100'), 'list');
  expect(next.items).toHaveLength(1);
  expect(next.total).toBe(1);
  expect(next.items[0]).toMatchObject({ type: 'privacy', version: 1 });
});
