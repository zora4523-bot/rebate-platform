import { expect, it } from 'vitest';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { context, input, notice, setup, toolCall } from './kit.ts';

it.each(['sequential', 'interleaved'] as const)(
  '[AC-B3-05b#42][BR-AI-06][BR-AI-14] 同一工厂的两个 run 独享时钟、Guard 和五项计数器：%s',
  async (mode) => {
    // Each run: 2 model rounds, 3 tools, 8 cards, 14948 code points, >200 frames.
    // Defaults (02 §9.1–9.2): 3 rounds / 4 tools / 12 cards / 20000 cp / 400 frames.
    // Each total fits; sharing ANY counter across the two runs exceeds its limit.
    // Two sentences consume the per-run guard budget as well. Emoji distinguish cp from UTF-16.
    const firstText = `${'😀'.repeat(14940)}第一句。`;
    const calls = ['a', 'b', 'c'].map((id) => toolCall(`synthetic-isolated-${id}`));
    const cards = Array.from({ length: 8 }, (_, i) => notice(`合成隔离卡${i}`));
    const r = setup([
      { parts: [firstText], calls, views: [{}, {}, {}] },
      { parts: ['第二句。第三句丢弃。'] },
    ]);
    const a = context('synthetic-run-a');
    const b = context('synthetic-run-b');
    const reachedTool = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    r.execute.mockImplementation(async (call, ctx) => {
      if (mode === 'interleaved' && ctx.runId === a.ctx.runId && call.id === calls[0]!.id) {
        reachedTool.resolve();
        await releaseTool.promise;
      }
      const group =
        call.id === calls[0]!.id
          ? cards.slice(0, 3)
          : call.id === calls[1]!.id
            ? cards.slice(3, 6)
            : cards.slice(6);
      return { kind: 'ok', modelView: {}, cards: group };
    });
    // Intentionally instantiate ONCE: setup.run() is unsuitable for this regression.
    const body = createAgentRunBody(r.deps);
    const first = body({ ...input(), runId: a.ctx.runId })(a.ctx);
    let firstResult;
    let secondResult;
    if (mode === 'sequential') {
      firstResult = await first;
      secondResult = await body({ ...input(), runId: b.ctx.runId })(b.ctx);
    } else {
      await reachedTool.promise;
      try {
        secondResult = await body({ ...input(), runId: b.ctx.runId })(b.ctx);
      } finally {
        releaseTool.resolve();
      }
      firstResult = await first;
    }
    expect([firstResult, secondResult]).toEqual([
      { kind: 'done', finishReason: 'stop' },
      { kind: 'done', finishReason: 'stop' },
    ]);
    for (const output of [a, b]) {
      expect(output.text()).toBe(`${firstText}第二句。`);
      expect(Array.from(output.text())).toHaveLength(14948);
      expect(output.events.filter((event) => event.kind === 'card')).toEqual(
        cards.map((card) => ({ kind: 'card', card })),
      );
      expect(output.content().length).toBeGreaterThan(200);
      expect(output.content().length).toBeLessThan(400);
      const completions = r.complete.mock.calls.filter(
        ([, ctx]) => ctx.signal === output.ctx.signal,
      );
      expect(completions).toHaveLength(2);
      expect(completions[1]?.[1].clock).toBe(completions[0]?.[1].clock);
      expect(
        r.execute.mock.calls.filter(([, ctx]) => ctx.signal === output.ctx.signal),
      ).toHaveLength(3);
    }
    expect(r.modelClocks).toHaveLength(2);
    expect(r.modelClocks[0]).not.toBe(r.modelClocks[1]);
    const clockA = r.complete.mock.calls.find(([, ctx]) => ctx.signal === a.ctx.signal)?.[1].clock;
    const clockB = r.complete.mock.calls.find(([, ctx]) => ctx.signal === b.ctx.signal)?.[1].clock;
    expect(clockA).toBe(r.modelClocks[0]);
    expect(clockB).toBe(r.modelClocks[1]);
    expect(r.traces).toHaveLength(2);
    expect(r.traces.every((trace) => trace.output_truncated)).toBe(true);
    expect(r.degraded).not.toHaveBeenCalled();
    r.replayed();
  },
);
