// B3-08g · BR-AI-03 / BR-AI-07: createOrderCardRefs (stream/mount/orders.ts) resolves a card_id the
// model quotes to the order behind an order_status card of THIS session of THIS app, read from
// app.agent_cards (real PG rows of earlier runs). The session and the app come from the server-side
// call context only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createOrderCardRefs } from '../../../../apps/api/src/modules/agent/stream/mount/orders.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { item } from '../tools-orders/kit.ts';
import { newMember, openAgent, usePgEach } from '../stream-mount/kit.ts';
import { APP, insertCard, insertRun, sessionOf } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ORDER_A = '0192f3a1-7c00-7000-8000-00000000a001';
const ORDER_B = '0192f3a1-7c00-7000-8000-00000000b002';

function ctxOf(caller: AgentCaller, sessionId: string, appId: string = caller.appId) {
  const ctx: ToolCallContext = {
    appId,
    userId: caller.userId,
    deviceId: caller.deviceId,
    phoneBound: caller.phoneBound,
    runId: randomUUID(),
    sessionId,
    signal: new AbortController().signal,
    placeholders: {},
  };
  return ctx;
}

async function twoSessions() {
  await openAgent(pg.db, APP);
  const a = await newMember(pg.db);
  const b = await newMember(pg.db);
  const sessionA = await sessionOf(pg.db, a);
  const sessionB = await sessionOf(pg.db, b);
  const runA = await insertRun(pg.db, sessionA);
  const runB = await insertRun(pg.db, sessionB);
  // Session A: an order card c3, a claim draft c4 and a cleared order card c5.
  await insertCard(pg.db, {
    sessionId: sessionA,
    runId: runA,
    cardId: 'c3',
    type: 'order_status',
    data: { ...item({ order_id: ORDER_A }) },
  });
  await insertCard(pg.db, {
    sessionId: sessionA,
    runId: runA,
    cardId: 'c4',
    type: 'claim_draft',
    data: {
      platform: 'jd',
      order_id: ORDER_A,
      order_no: '3900112233',
      click_times: [],
      evidence_summary: null,
    },
  });
  await insertCard(pg.db, {
    sessionId: sessionA,
    runId: runA,
    cardId: 'c5',
    type: 'order_status',
    data: {},
  });
  // Session B: its own c3 for another order, and c7 that session A does not have.
  await insertCard(pg.db, {
    sessionId: sessionB,
    runId: runB,
    cardId: 'c3',
    type: 'order_status',
    data: { ...item({ order_id: ORDER_B }) },
  });
  await insertCard(pg.db, {
    sessionId: sessionB,
    runId: runB,
    cardId: 'c7',
    type: 'order_status',
    data: { ...item({ order_id: ORDER_B }) },
  });
  return { a, b, sessionA, sessionB };
}

it('[AC-B3-08g#6][BR-AI-07] 本会话 order_status 卡 → {kind: order, orderId: data.order_id}；同号卡按各自会话解析', async () => {
  const s = await twoSessions();
  const refs = createOrderCardRefs(pg.db);
  expect(await refs.resolve('c3', ctxOf(s.a, s.sessionA))).toEqual({
    kind: 'order',
    orderId: ORDER_A,
  });
  expect(await refs.resolve('c3', ctxOf(s.b, s.sessionB))).toEqual({
    kind: 'order',
    orderId: ORDER_B,
  });
}, 120_000);

it('[AC-B3-08g#6][BR-AI-03][BR-AI-07] 别的会话、别的 app、非 order_status 卡、不存在、data 已清空、card_id 格式非法 → 一律 {kind: invalid}', async () => {
  const s = await twoSessions();
  const refs = createOrderCardRefs(pg.db);
  const invalid = { kind: 'invalid' };
  const cases: readonly (readonly [string, string, ToolCallContext])[] = [
    ['card of another session', 'c7', ctxOf(s.a, s.sessionA)],
    ['same user, a session that has no cards', 'c3', ctxOf(s.a, randomUUID())],
    ['another app, same session id', 'c3', ctxOf(s.a, s.sessionA, 'another-app')],
    ['claim_draft card (not order_status)', 'c4', ctxOf(s.a, s.sessionA)],
    ['no such card', 'c99', ctxOf(s.a, s.sessionA)],
    ['cleared card data', 'c5', ctxOf(s.a, s.sessionA)],
    ['card_id c0', 'c0', ctxOf(s.a, s.sessionA)],
    ['card_id C3', 'C3', ctxOf(s.a, s.sessionA)],
    ['card_id 3', '3', ctxOf(s.a, s.sessionA)],
    ['card_id c03', 'c03', ctxOf(s.a, s.sessionA)],
    ['card_id with spaces', ' c3 ', ctxOf(s.a, s.sessionA)],
    ['card_id with a suffix', 'c3;', ctxOf(s.a, s.sessionA)],
    ['card_id as an order id', ORDER_A, ctxOf(s.a, s.sessionA)],
  ];
  for (const [label, cardId, ctx] of cases) {
    expect(await refs.resolve(cardId, ctx), label).toEqual(invalid);
  }
  // The valid reference still resolves in the same table (the cases above are not a broken read).
  expect(await refs.resolve('c3', ctxOf(s.a, s.sessionA))).toEqual({
    kind: 'order',
    orderId: ORDER_A,
  });
}, 120_000);
