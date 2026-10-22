import { expect, it } from 'vitest';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { chainKit } from './kit.ts';

// Task §9 #5: group by signal identity and then runId; observable limits only, no GC assertions.
it('[AC-B3-05k#5][BR-AI-08] 每 run 恰好四次，第五次不调内层；新 signal 与新 runId 分别隔离', async () => {
  const h = chainKit();
  h.execute.mockResolvedValue({ kind: 'ok', cards: [], modelView: {} });
  const r1 = { ...h.ctx, runId: 'synthetic-r1', signal: new AbortController().signal };
  const r2 = { ...h.ctx, runId: 'synthetic-r2', signal: new AbortController().signal };
  const r1NewSignal = { ...r1, signal: new AbortController().signal };
  const r3SameSignal = { ...r2, runId: 'synthetic-r3' };
  for (const ctx of [r1, r2, r1NewSignal, r3SameSignal]) {
    const before = h.execute.mock.calls.length;
    for (let i = 0; i < 4; i += 1) {
      expect(await h.call({}, ctx, 'get_my_earnings')).toMatchObject({ kind: 'ok' });
    }
    expect(h.execute.mock.calls.length - before).toBe(4);
    expect(await h.call({}, ctx, 'get_my_earnings')).toMatchObject({ kind: 'failed' });
    expect(h.execute.mock.calls.length - before).toBe(4);
  }
});

it('[AC-B3-05k#5][BR-AI-08] 属性：N 个 run 用满后最后一个仍恰好四次，新 signal 不继承旧预算', async () => {
  const h = chainKit();
  h.execute.mockResolvedValue({ kind: 'ok', cards: [], modelView: {} });
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (runs) => {
      h.execute.mockClear();
      for (let index = 0; index < runs; index += 1) {
        const ctx = {
          ...h.ctx,
          runId: `synthetic-property-run-${index}`,
          signal: new AbortController().signal,
        };
        const before = h.execute.mock.calls.length;
        const kinds = [];
        for (let call = 0; call < 5; call += 1) {
          kinds.push((await h.call({}, ctx, 'get_my_earnings')).kind);
        }
        expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok', 'failed']);
        expect(h.execute.mock.calls.length - before).toBe(4);
      }
      expect(h.execute).toHaveBeenCalledTimes(runs * 4);
      const fresh = {
        ...h.ctx,
        runId: `synthetic-property-run-${runs - 1}`,
        signal: new AbortController().signal,
      };
      h.execute.mockClear();
      const kinds = [];
      for (let call = 0; call < 5; call += 1) {
        kinds.push((await h.call({}, fresh, 'get_my_earnings')).kind);
      }
      expect(kinds).toEqual(['ok', 'ok', 'ok', 'ok', 'failed']);
      expect(h.execute).toHaveBeenCalledTimes(4);
    }),
    propParams(),
  );
}, 120_000);
