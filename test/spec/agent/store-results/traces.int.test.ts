import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createPgAgentTraceWriter,
  type ToolCallRecord,
} from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { CardInput } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import { connect, newLink } from '../../db/linking-bindings/kit.ts';
import { APP, OTHER_APP, databaseKit } from './kit.ts';

const h = databaseKit(createTestDatabase);

function writer() {
  return createPgAgentTraceWriter({ db: h.db(), newId: randomUUID });
}

function card(cardId = 'c1'): CardInput {
  return {
    card_id: cardId,
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'synthetic.notice', actions: [] },
    fallback_text: '合成提示卡',
  };
}

const calls: readonly ToolCallRecord[] = [
  {
    seq: 1,
    name: 'search_products',
    args: { q: '合成牛奶', platforms: ['jd'] },
    result_digest: 'synthetic-result-digest',
    status: 'ok',
    latency_ms: 25,
  },
  {
    seq: 2,
    name: 'get_rebate_quote',
    args: { card_id: 'c1' },
    result_digest: null,
    status: 'failed',
    latency_ms: 0,
  },
  {
    seq: 3,
    name: 'synthetic_rejected_tool',
    args: null,
    result_digest: null,
    status: 'rejected',
    latency_ms: null,
  },
];

it('[AC-B3-09c#8][BR-AI-23] 卡片与工具调用并发及重试不重复，所有输入列原样留痕', async () => {
  const first = writer();
  const second = writer();
  const scope = await h.scope();
  const cards = [
    card('c1'),
    {
      ...card('c2'),
      type: 'rule_ref',
      schema_version: 2,
      data: { chunk_id: 'synthetic-rule', title: '合成规则' },
      fallback_text: '合成规则卡',
    },
  ];
  await Promise.all(
    [first, second].map((w) => w.recordCards(APP, scope.sessionId, scope.runId, cards)),
  );
  await writer().recordCards(APP, scope.sessionId, scope.runId, cards);
  const rows = await sql`SELECT app_id, session_id, run_id, card_id, type, data,
    link_id, schema_version, fallback_text FROM app.agent_cards WHERE run_id = ${scope.runId}
    ORDER BY card_id`.execute(h.db());
  expect(rows.rows).toEqual(
    cards.map((value) => ({
      ...value,
      app_id: APP,
      session_id: scope.sessionId,
      run_id: scope.runId,
      link_id: null,
    })),
  );
  await Promise.all([first, second].map((w) => w.recordToolCalls(APP, scope.runId, calls)));
  await writer().recordToolCalls(APP, scope.runId, calls);
  const toolRows = await sql`SELECT app_id, run_id, seq, name, args, result_digest, status,
    latency_ms FROM app.agent_tool_calls WHERE run_id = ${scope.runId} ORDER BY seq`.execute(
    h.db(),
  );
  expect(toolRows.rows).toEqual(
    calls.map((value) => ({ ...value, app_id: APP, run_id: scope.runId })),
  );
});

it('[AC-B3-09c#8][BR-AI-23] 卡片 link_id 只从 data 顶层字符串取，其他形状为 null', async () => {
  const w = writer();
  const scope = await h.scope();
  connect(h.db());
  const linkId = await newLink({ app_id: APP });
  const cards = [
    { ...card('c1'), data: { link_id: linkId } },
    { ...card('c2'), data: { nested: { link_id: linkId } } },
    { ...card('c3'), data: { link_id: 42 } },
    { ...card('c4'), data: { link_id: null } },
  ];
  await w.recordCards(APP, scope.sessionId, scope.runId, cards);
  const rows = await sql`SELECT card_id, data, link_id FROM app.agent_cards
    WHERE run_id = ${scope.runId} ORDER BY card_id`.execute(h.db());
  expect(rows.rows).toEqual(
    cards.map((value, index) => ({
      card_id: value.card_id,
      data: value.data,
      link_id: index === 0 ? linkId : null,
    })),
  );
});

it('[AC-B3-09c#8][BR-AI-23] 错误会话、app 或不存在的 run 被拒绝且不留痕', async () => {
  const w = writer();
  const own = await h.scope();
  const other = await h.scope();
  const foreign = await h.scope(OTHER_APP);
  for (const bad of [
    { ...own, runId: other.runId },
    { ...foreign, appId: APP },
    { ...own, runId: randomUUID() },
  ]) {
    await expect(w.recordCards(bad.appId, bad.sessionId, bad.runId, [card()])).rejects.toThrow();
    expect(
      (await sql`SELECT id FROM app.agent_cards WHERE run_id = ${bad.runId}`.execute(h.db())).rows,
    ).toEqual([]);
  }
  for (const runId of [foreign.runId, randomUUID()]) {
    await expect(w.recordToolCalls(APP, runId, calls)).rejects.toThrow();
    expect(
      (await sql`SELECT id FROM app.agent_tool_calls WHERE run_id = ${runId}`.execute(h.db())).rows,
    ).toEqual([]);
  }
});

it.each(['c0', 'c01', 'C1', '1', 'c-1', 'c1.5', '', 'c1\n'])(
  '[AC-B3-09c#8][BR-AI-23][BR-AI-05] 非法 card_id %j 被拒绝且不写入',
  async (cardId) => {
    const w = writer();
    const scope = await h.scope();
    await expect(
      w.recordCards(APP, scope.sessionId, scope.runId, [card(cardId)]),
    ).rejects.toThrow();
    expect(
      (await sql`SELECT id FROM app.agent_cards WHERE run_id = ${scope.runId}`.execute(h.db()))
        .rows,
    ).toEqual([]);
  },
);

it('[AC-B3-09c#8][BR-AI-23] 留痕幂等键不串会话、app 或不同 run 的工具序号', async () => {
  const w = writer();
  const scopes = [await h.scope(), await h.scope(), await h.scope(OTHER_APP)];
  for (const scope of scopes) {
    await w.recordCards(scope.appId, scope.sessionId, scope.runId, [card('c1')]);
    await w.recordToolCalls(scope.appId, scope.runId, calls);
    const next = await h.run(scope.appId, scope.sessionId);
    await w.recordToolCalls(next.appId, next.runId, calls);
    expect(
      (await sql`SELECT card_id FROM app.agent_cards WHERE run_id = ${scope.runId}`.execute(h.db()))
        .rows,
    ).toEqual([{ card_id: 'c1' }]);
    for (const runId of [scope.runId, next.runId]) {
      expect(
        (
          await sql`SELECT seq, name, args, result_digest, status, latency_ms
        FROM app.agent_tool_calls WHERE run_id = ${runId} ORDER BY seq`.execute(h.db())
        ).rows,
      ).toEqual(calls);
    }
  }
});
