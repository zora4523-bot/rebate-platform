// Rule tests for the Bailian streaming stubs of QA-06b (规划/05 QA-06「Agent SSE……上游用 WireMock」;
// 09 CAP-X-07「流式时 tool_calls 参数分多个 chunk 返回，需拼接」). The stub bodies must be consumed
// by B3-02b's own parser and assembler (createSseChunkParser, assembleChunks, usageOf), so a load
// run exercises the real streaming path. Synthetic content only. Top-level it() only.
import { expect, it } from 'vitest';
import {
  assembleChunks,
  createSseChunkParser,
  usageOf,
  type ModelEvent,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import {
  buildLoadImport,
  type LoadStubMapping,
  type LoadStubOptions,
} from '../../../../infra/load/wiremock/stubs.ts';
import { bailianProbe, firstTurnBody, secondTurnBody, wiremock } from './kit.ts';

function stubFor(
  body: string,
  options: LoadStubOptions = {},
): LoadStubMapping | null | 'ambiguous' {
  return wiremock(buildLoadImport([], options).mappings)(bailianProbe(body));
}

/** Feeds the SSE text through B3-02b's parser in `size`-character pieces. */
function parse(text: string, size: number) {
  const parser = createSseChunkParser();
  const chunks: unknown[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(...parser.push(text.slice(i, i + size)));
  chunks.push(...parser.end());
  return { chunks, finished: parser.finished };
}

function summary(events: readonly ModelEvent[]) {
  return {
    texts: events.filter((e) => e.t === 'text_delta').length,
    tools: events.flatMap((e) =>
      e.t === 'tool_call'
        ? [{ name: e.call.function.name, args: JSON.parse(e.call.function.arguments) as unknown }]
        : [],
    ),
    done: events.flatMap((e) => (e.t === 'done' ? [e.reason] : [])),
  };
}

function toolFragments(chunks: readonly unknown[]): number {
  return chunks.filter((c) =>
    JSON.stringify((c as { choices?: unknown }).choices ?? []).includes('"tool_calls"'),
  ).length;
}

function usageOnly(chunks: readonly unknown[]): number {
  return chunks.filter((c) => {
    const r = c as { choices?: unknown[]; usage?: unknown };
    return Array.isArray(r.choices) && r.choices.length === 0 && r.usage !== undefined;
  }).length;
}

it('[规划/05 QA-06 Agent SSE] 首轮请求得到 text/event-stream 应答，B3-02b 解析出分多片的默认工具调用、tool_calls 结束、单独的 usage 片与 [DONE]', () => {
  const hit = stubFor(firstTurnBody());
  expect(hit === null || hit === 'ambiguous' ? hit : 'stub').toBe('stub');
  if (hit === null || hit === 'ambiguous') return;
  expect(hit.response.status).toBe(200);
  const type = Object.entries(hit.response.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'content-type',
  );
  expect(type?.[1] ?? '').toMatch(/^text\/event-stream/);
  const text = hit.response.body ?? '';
  expect(text).toMatch(/^data: \[DONE\]$/m);
  for (const size of [text.length || 1, 7, 1]) {
    const { chunks, finished } = parse(text, size);
    expect(finished, `piece ${String(size)}`).toBe(true);
    expect({ fragments: toolFragments(chunks) >= 2, usageChunks: usageOnly(chunks) >= 1 }).toEqual({
      fragments: true,
      usageChunks: true,
    });
    const events = assembleChunks(chunks);
    const s = summary(events);
    expect({ names: s.tools.map((t) => t.name), done: s.done }).toEqual({
      names: ['search_products'],
      done: ['tool_calls'],
    });
    expect(typeof s.tools[0]?.args === 'object' && s.tools[0]?.args !== null).toBe(true);
    const usage = usageOf(events);
    expect(Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens)).toBe(
      true,
    );
  }
});

it('[规划/05 QA-06 Agent SSE] 带工具结果的第二轮请求得到文本应答：至少两段文本增量、stop 结束、usage 片、[DONE]，不再发工具调用', () => {
  const hit = stubFor(secondTurnBody());
  expect(hit === null || hit === 'ambiguous' ? hit : 'stub').toBe('stub');
  if (hit === null || hit === 'ambiguous') return;
  const { chunks, finished } = parse(hit.response.body ?? '', 5);
  expect(finished).toBe(true);
  const events = assembleChunks(chunks);
  const s = summary(events);
  expect({
    multiText: s.texts >= 2,
    tools: s.tools,
    done: s.done,
    usageChunks: usageOnly(chunks) >= 1,
  }).toEqual({
    multiText: true,
    tools: [],
    done: ['stop'],
    usageChunks: true,
  });
  expect(usageOf(events).output_tokens).toBeGreaterThan(0);
});

it('[可配置 toolCall] 换一个工具名与参数后，拼出的工具调用正是配置的名字与参数（不只默认值）', () => {
  const options: LoadStubOptions = {
    toolCall: { name: 'parse_input', arguments: { text: '合成口令', n: 2, nested: { ok: true } } },
  };
  const hit = stubFor(firstTurnBody(), options);
  expect(hit === null || hit === 'ambiguous' ? hit : 'stub').toBe('stub');
  if (hit === null || hit === 'ambiguous') return;
  const { chunks } = parse(hit.response.body ?? '', 3);
  expect(toolFragments(chunks)).toBeGreaterThanOrEqual(2);
  expect(summary(assembleChunks(chunks)).tools).toEqual([
    { name: 'parse_input', args: { text: '合成口令', n: 2, nested: { ok: true } } },
  ]);
});

it('[09 README §0.2 硬规则 5] 百炼桩只答本地路径上的 POST，不匹配鉴权头的取值（桩里没有任何密钥），GET 与别的路径不命中', () => {
  const { mappings } = buildLoadImport([], {});
  const serve = wiremock(mappings);
  const get = serve({ ...bailianProbe(firstTurnBody()), method: 'GET' });
  const other = serve({
    ...bailianProbe(firstTurnBody()),
    url: '/bailian/compatible-mode/v1/embeddings',
  });
  expect({ get, other }).toEqual({ get: null, other: null });
  const authMatchers = mappings.flatMap((m) =>
    Object.keys(m.request.headers ?? {}).filter((h) => /authorization|api-?key/i.test(h)),
  );
  expect(authMatchers).toEqual([]);
  expect(mappings.length).toBeGreaterThan(0);
});
