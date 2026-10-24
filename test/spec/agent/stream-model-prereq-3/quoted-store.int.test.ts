// B3-03q §9 items 1–3 · BR-AI-05: the PG result store (agent/store/results createPgResultSetStore)
// keeps the product of a written rebate_quote card like the in-memory store does (B3-03p): found by
// its card_id in the same app and session in any later round, never in another app or session,
// never the result set 「第 N 个」 addresses; recorded once (repeats and concurrent calls, the first
// one wins) and session-wide unique with the product_list deliveries. Behaviour only: no table,
// column or row count is asserted. Real PG through the store-results kit, business role only.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createReferenceResolver } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { APP, OTHER_APP, databaseKit, delivered, input, product } from '../store-results/kit.ts';
import { lookupOf, quoted, quotedPort } from './kit.ts';

const h = databaseKit(createTestDatabase);

it('[AC-B3-03q#1][BR-AI-05] PG 结果库支持 recordQuoted：记下的报价卡商品同 app 同会话按 card_id 可查（商品键、平台、到手价分、卡片内容与写出时一致），换实例仍在；别的 app、别的会话查不到', async () => {
  const store = quotedPort(h.store());
  const own = await h.scope();
  const first = quoted('c4', 'jd:synthetic-quoted-a', 2590);
  await store.recordQuoted(own, [first]);
  // A later round (another run) of the same session.
  const later = await h.run(APP, own.sessionId);
  const second = quoted('c9', 'jd:synthetic-quoted-b', 0);
  await store.recordQuoted(later, [second]);

  for (const reader of [store, h.store()]) {
    expect(await reader.findDelivered(APP, own.sessionId, 'c4')).toEqual(first);
    expect(await reader.findDelivered(APP, own.sessionId, 'c9')).toEqual(second);
  }
  const resolver = createReferenceResolver({ store: h.store() });
  expect(await resolver.resolve({ card_id: 'c4' }, lookupOf(APP, own.sessionId))).toEqual({
    kind: 'product',
    productKey: 'jd:synthetic-quoted-a',
  });

  // Another session of the same app and another app quote under the same card_id: no shadowing.
  const otherSession = await h.scope();
  const otherApp = await h.scope(OTHER_APP);
  expect(await store.findDelivered(APP, otherSession.sessionId, 'c4')).toBeNull();
  expect(await store.findDelivered(OTHER_APP, own.sessionId, 'c4')).toBeNull();
  expect(await store.findDelivered(OTHER_APP, otherApp.sessionId, 'c4')).toBeNull();
  const foreign = quoted('c4', 'jd:synthetic-foreign', 1990);
  await store.recordQuoted(otherApp, [foreign]);
  expect(await h.store().findDelivered(OTHER_APP, otherApp.sessionId, 'c4')).toEqual(foreign);
  expect(await h.store().findDelivered(APP, own.sessionId, 'c4')).toEqual(first);
  expect(await h.store().findDelivered(APP, otherSession.sessionId, 'c4')).toBeNull();
  expect(await resolver.resolve({ card_id: 'c4' }, lookupOf(APP, otherSession.sessionId))).toEqual({
    kind: 'invalid_args',
  });

  // Only what was recorded: other card ids, malformed sessions and empty calls find nothing.
  await store.recordQuoted(own, []);
  for (const cardId of ['c1', 'c5', 'c10', '']) {
    expect(await store.findDelivered(APP, own.sessionId, cardId), cardId).toBeNull();
  }
  for (const sessionId of ['not-uuid', '']) {
    expect(await store.findDelivered(APP, sessionId, 'c4'), sessionId).toBeNull();
  }
});

it('[AC-B3-03q#2][BR-AI-05] 报价卡商品不进「第 N 个」：只有报价卡时 latestWithProducts 为空；先有 product_list 后有报价卡时仍返回那批 product_list，序号与内容不变', async () => {
  const store = quotedPort(h.store());

  // Only quotes in the session: no result set for 「第 N 个」, the card_id still resolves.
  const onlyQuotes = await h.scope();
  await store.recordQuoted(onlyQuotes, [quoted('c2', 'jd:synthetic-only-quote')]);
  expect(await store.latestWithProducts(APP, onlyQuotes.sessionId)).toBeNull();
  expect(await h.store().latestWithProducts(APP, onlyQuotes.sessionId)).toBeNull();
  const onlyResolver = createReferenceResolver({ store: h.store() });
  const onlyLookup = lookupOf(APP, onlyQuotes.sessionId);
  expect(await onlyResolver.resolve({ ref_ordinal: 1 }, onlyLookup)).toEqual({ kind: 'clarify' });
  expect(await onlyResolver.resolve({ card_id: 'c2' }, onlyLookup)).toEqual({
    kind: 'product',
    productKey: 'jd:synthetic-only-quote',
  });

  // A product_list first, then quotes in later rounds: the list stays the latest result set.
  const own = await h.scope();
  const value = input(own);
  const a = delivered('c2', product('jd:synthetic-list-a', 3000));
  const b = delivered('c3', product('jd:synthetic-list-b', 2000));
  await store.save(value);
  await store.recordDelivered(value.id, [a, b]);
  const quoteRun = await h.run(APP, own.sessionId);
  await store.recordQuoted(quoteRun, [quoted('c5', 'jd:synthetic-quote-later')]);
  await store.recordQuoted(await h.run(APP, own.sessionId), [
    quoted('c7', 'jd:synthetic-quote-latest'),
  ]);
  for (const reader of [store, h.store()]) {
    expect(await reader.latestWithProducts(APP, own.sessionId)).toEqual({
      ...value,
      delivered: [a, b],
    });
  }
  const resolver = createReferenceResolver({ store: h.store() });
  const lookup = lookupOf(APP, own.sessionId);
  expect(await resolver.resolve({ ref_ordinal: 1 }, lookup)).toEqual({
    kind: 'product',
    productKey: 'jd:synthetic-list-a',
  });
  expect(await resolver.resolve({ ref_ordinal: 2 }, lookup)).toEqual({
    kind: 'product',
    productKey: 'jd:synthetic-list-b',
  });
  expect(await resolver.resolve({ ref_ordinal: 3 }, lookup)).toEqual({ kind: 'clarify' });
  for (const [cardId, productKey] of [
    ['c2', 'jd:synthetic-list-a'],
    ['c5', 'jd:synthetic-quote-later'],
    ['c7', 'jd:synthetic-quote-latest'],
  ] as const) {
    expect(await resolver.resolve({ card_id: cardId }, lookup), cardId).toEqual({
      kind: 'product',
      productKey,
    });
  }

  // A newer product_list after the quotes becomes the latest result set as usual.
  const newer = input(await h.run(APP, own.sessionId));
  const c = delivered('c9', product('jd:synthetic-list-newer', 1500));
  await store.save(newer);
  await store.recordDelivered(newer.id, [c]);
  expect(await h.store().latestWithProducts(APP, own.sessionId)).toEqual({
    ...newer,
    delivered: [c],
  });
  expect(await resolver.resolve({ card_id: 'c5' }, lookup)).toEqual({
    kind: 'product',
    productKey: 'jd:synthetic-quote-later',
  });
});

it('[AC-B3-03q#3][BR-AI-05] recordQuoted 幂等且并发安全：同一 card_id 重复记、同次重复、两实例并发记都只留先到的一条，调用不报错', async () => {
  const store = quotedPort(h.store());
  const second = quotedPort(h.store());
  const own = await h.scope();

  const first = quoted('c7', 'jd:synthetic-first', 1000);
  await store.recordQuoted(own, [first]);
  await expect(
    second.recordQuoted(own, [quoted('c7', 'jd:synthetic-rival', 2000)]),
  ).resolves.toBeUndefined();
  await expect(store.recordQuoted(own, [first])).resolves.toBeUndefined();
  expect(await h.store().findDelivered(APP, own.sessionId, 'c7')).toEqual(first);

  // Twice in one call: the first item wins.
  const head = quoted('c8', 'jd:synthetic-head', 1200);
  await store.recordQuoted(own, [head, quoted('c8', 'jd:synthetic-tail', 1300)]);
  expect(await h.store().findDelivered(APP, own.sessionId, 'c8')).toEqual(head);

  // Concurrent calls of two instances: every call resolves, one product stays, read back stably.
  const racers = Array.from({ length: 8 }, (_, i) =>
    quoted('c9', `jd:synthetic-racer-${String(i)}`, 1000 + i),
  );
  const settled = await Promise.allSettled(
    racers.map((item, i) => (i % 2 === 0 ? store : second).recordQuoted(own, [item])),
  );
  expect(settled.map((entry) => entry.status)).toEqual(racers.map(() => 'fulfilled'));
  const winner = await h.store().findDelivered(APP, own.sessionId, 'c9');
  expect(winner).not.toBeNull();
  expect(racers).toContainEqual(winner);
  for (let i = 0; i < 3; i += 1) {
    expect(await h.store().findDelivered(APP, own.sessionId, 'c9')).toEqual(winner);
  }
  // A later write of the same card_id never replaces the winner.
  await store.recordQuoted(await h.run(APP, own.sessionId), [quoted('c9', 'jd:synthetic-late')]);
  expect(await h.store().findDelivered(APP, own.sessionId, 'c9')).toEqual(winner);
});

it('[AC-B3-03q#3][BR-AI-05] 报价卡商品与 product_list 的 card_id 同会话唯一：同号先到者为准，后到的不改写它', async () => {
  const store = quotedPort(h.store());
  const own = await h.scope();

  // product_list first: a quote under the same card_id never overwrites it.
  const value = input(own);
  const listed = delivered('c2', product('jd:synthetic-listed', 3000));
  await store.save(value);
  await store.recordDelivered(value.id, [listed]);
  await expect(
    store.recordQuoted(await h.run(APP, own.sessionId), [quoted('c2', 'jd:synthetic-quote-late')]),
  ).resolves.toBeUndefined();
  expect(await h.store().findDelivered(APP, own.sessionId, 'c2')).toEqual(listed);
  expect(await h.store().latestWithProducts(APP, own.sessionId)).toEqual({
    ...value,
    delivered: [listed],
  });

  // Quote first: a later product_list delivery under the same card_id is skipped, its other
  // products are kept in delivery order.
  const early = quoted('c6', 'jd:synthetic-quote-early', 1800);
  await store.recordQuoted(await h.run(APP, own.sessionId), [early]);
  const next = input(await h.run(APP, own.sessionId));
  const clash = delivered('c6', product('jd:synthetic-list-clash', 900));
  const kept = delivered('c7', product('jd:synthetic-list-kept', 800));
  await store.save(next);
  await store.recordDelivered(next.id, [clash, kept]);
  expect(await h.store().findDelivered(APP, own.sessionId, 'c6')).toEqual(early);
  expect(await h.store().findDelivered(APP, own.sessionId, 'c7')).toEqual(kept);
  expect(await h.store().latestWithProducts(APP, own.sessionId)).toEqual({
    ...next,
    delivered: [kept],
  });
});
