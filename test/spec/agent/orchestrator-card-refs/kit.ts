import { expect } from 'vitest';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { AgentRunBodyDeps } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { AssembledToolCall } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { input, productList as coreProductList, setup } from '../orchestrator-core/kit.ts';
import { framesOf, rig } from '../stream-run/kit.ts';

export { notice, toolCall } from '../orchestrator-core/kit.ts';
export { cardReference } from '../../../../apps/api/src/modules/agent/orchestrator/core/card-references.ts';

export function productList(count: number) {
  const card = coreProductList(count);
  const data = card.data as { items: Record<string, unknown>[] };
  // The old core kit stops before stream validation. This suite reaches the real writer,
  // whose timestamp contract requires +08:00 rather than the kit's UTC Z spelling.
  for (const item of data.items) item['quoted_at'] = '2026-10-15T08:00:00.000+08:00';
  return card;
}

/** Core's existing kit + real RunManager; only model, storage and transport ports are fakes.
 * No fake delivery receipt and no model-view rewriting in this harness. */
export function harness(
  rounds: readonly { calls?: readonly AssembledToolCall[]; text?: string }[],
  cardFirsts?: number[],
) {
  const core = setup();
  for (const round of rounds) {
    core.complete.mockResolvedValueOnce({
      kind: 'model',
      entryId: 'flash',
      model: 'qwen-flash-2026-09-01',
      usage: { input_tokens: 20, output_tokens: 10 },
      attempts: [],
      events: [
        ...(round.text === undefined ? [] : [{ t: 'text_delta' as const, text: round.text }]),
        ...(round.calls ?? []).map((call, index) => ({ t: 'tool_call' as const, index, call })),
        { t: 'done', reason: round.calls?.length ? 'tool_calls' : 'stop' },
      ],
    });
  }
  const stream = rig({
    // Injected test timing; no sleeps or real services (same stream-run kit configuration).
    config: {
      maxRunMs: 60000,
      heartbeatMs: 15000,
      disconnectGraceMs: 30000,
      guardPollMs: 5000,
      signalPollMs: 500,
    },
    ...(cardFirsts === undefined ? {} : { cardFirsts }),
  });
  const issued: string[] = [];
  return {
    ...core,
    stream,
    issued,
    async run(patch: Partial<AgentRunBodyDeps> = {}) {
      const value = {
        ...input(),
        runId: stream.start.ticket.runId,
        sessionId: stream.start.ticket.sessionId,
      };
      return stream.manager.start(
        stream.start,
        createAgentRunBody({ ...core.deps, ...patch })(value),
      );
    },
    cards: () => framesOf(stream.sink.chunks).filter((frame) => frame.event === 'card'),
    views: (round: number) =>
      (core.complete.mock.calls[round]?.[0].messages ?? []).flatMap((message) => {
        if (message.role !== 'tool') return [];
        expect(message.content).toBeTypeOf('string');
        return [JSON.parse(message.content as string) as unknown];
      }),
    noLeaks() {
      expect(issued.length).toBeGreaterThan(0);
      const exposed = JSON.stringify({
        model: core.complete.mock.calls.map(([chat]) => chat),
        traces: core.traces,
        frames: framesOf(stream.sink.chunks),
      });
      for (const token of issued) expect(exposed).not.toContain(token);
    },
  };
}
