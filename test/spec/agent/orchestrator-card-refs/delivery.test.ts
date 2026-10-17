import { expect, it, vi } from 'vitest';
import { flush } from '../stream-run/kit.ts';
import { cardReference, harness, notice, toolCall } from './kit.ts';

it('[AC-B3-05i#9][BR-AI-05][BR-AI-06] 中间卡被拒绝后删除对象字段和数组元素，其余引用按实际下发编号回填', async () => {
  const r = harness([{ calls: [toolCall('synthetic-drop')] }, {}]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const [a, b, c] = [0, 1, 2].map((index) => cardReference(ctx, index));
    r.issued.push(a!, b!, c!);
    return {
      kind: 'ok',
      cards: [
        notice('合成甲'),
        { ...notice('合成无效卡'), data: { level: 'synthetic-invalid' } },
        notice('合成丙'),
      ],
      modelView: {
        a,
        drop: b,
        c,
        nested: { drop: b, keep: a, child: { drop: b, title: '<untrusted>合成标题</untrusted>' } },
        list: [b, a, b, c, b, null, false, { drop: b, keep: c }, [b, a]],
      },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1', 'c3']);
  expect(r.views(1)).toEqual([
    {
      a: 'c1',
      c: 'c3',
      nested: { keep: 'c1', child: { title: '<untrusted>合成标题</untrusted>' } },
      list: ['c1', 'c3', null, false, { keep: 'c3' }, ['c1']],
    },
  ]);
  r.noLeaks();
});

it('[AC-B3-05i#10][BR-AI-05][BR-AI-06] 全部卡无效时保留投影容器和普通值，引用数组压缩为空而非 null 占位', async () => {
  const r = harness([{ calls: [toolCall('synthetic-all-dropped')] }, {}]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    return {
      kind: 'ok',
      cards: [{ ...notice(), data: { level: 'synthetic-invalid' } }],
      modelView: {
        card_id: ref,
        refs: [ref, ref],
        nested: { card_id: ref },
        state: 'synthetic-empty',
      },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.cards()).toEqual([]);
  expect(r.views(1)).toEqual([{ refs: [], nested: {}, state: 'synthetic-empty' }]);
  r.noLeaks();
});

it('[AC-B3-05i#11][BR-AI-05][BR-AI-06] sink 写卡失败及之后静默丢弃的卡不产生模型引用', async () => {
  const r = harness([{ calls: [toolCall('synthetic-write-failure')] }, {}]);
  // meta + tool.start + tool.end + first card succeed; the next card's write fails.
  r.stream.sink.failAt = 5;
  r.execute.mockImplementation(async (_call, ctx) => {
    const refs = [0, 1, 2].map((index) => cardReference(ctx, index));
    r.issued.push(...refs);
    return {
      kind: 'ok',
      cards: refs.map(() => notice()),
      modelView: { first: refs[0], second: refs[1], third: refs[2], refs },
    };
  });
  expect((await r.run()).ending).toBe('stop');
  expect(r.stream.sink.failures).toBe(1);
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1']);
  expect(r.views(1)).toEqual([{ first: 'c1', refs: ['c1'] }]);
  r.noLeaks();
});

it('[AC-B3-05i#12][BR-AI-05][BR-AI-06] 整轮卡片额度跨工具累计，越界卡及其引用不会发给模型或 trace', async () => {
  const r = harness([{ calls: [toolCall('synthetic-first'), toolCall('synthetic-overflow')] }]);
  r.execute.mockImplementation(async (call, ctx) => {
    // Existing B3-05b limit: 12 cards in the run, including all calls.
    const count = call.id === 'synthetic-first' ? 11 : 2;
    const refs = Array.from({ length: count }, (_, index) => cardReference(ctx, index));
    r.issued.push(...refs);
    return {
      kind: 'ok',
      cards: refs.map(() => notice()),
      modelView: { refs },
      trace: {
        card_sources: refs.map((ref) => ({ card_id: ref, fields: { source: 'synthetic-source' } })),
      },
    };
  });
  expect((await r.run()).ending).toBe('limit');
  expect(r.execute).toHaveBeenCalledTimes(2);
  expect(r.cards()).toHaveLength(12);
  // Preserve B3-05b#27: the run terminates at the cap, with no next model request.
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.issued).toHaveLength(13);
  r.noLeaks();
});

it('[AC-B3-05i#13][BR-AI-05][BR-AI-06] 帧额度耗尽后不发剩余引用卡，不为回填继续调用模型', async () => {
  const r = harness([{ calls: [toolCall('synthetic-frame-cap')] }]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const refs = [0, 1].map((index) => cardReference(ctx, index));
    r.issued.push(...refs);
    return {
      kind: 'ok',
      cards: refs.map(() => notice()),
      modelView: refs,
      trace: {
        card_sources: refs.map((ref) => ({ card_id: ref, fields: { source: 'synthetic-source' } })),
      },
    };
  });
  // Inject a reduced port limit to exercise the boundary; not a new business default.
  expect((await r.run({ limits: { ...r.deps.limits, contentFrames: 1 } })).ending).toBe('limit');
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1']);
  expect(r.complete).toHaveBeenCalledTimes(1);
  r.noLeaks();
});

it('[AC-B3-05i#14][BR-AI-05][BR-AI-06] 码点额度终止模型轮次，上一工具的引用已回填且后续工具不执行', async () => {
  const r = harness([
    { calls: [toolCall('synthetic-before-text-cap')] },
    { text: '😀😀。', calls: [toolCall('synthetic-after-text-cap')] },
  ]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const ref = cardReference(ctx, 0);
    r.issued.push(ref);
    return { kind: 'ok', cards: [notice()], modelView: { card_id: ref } };
  });
  // Reduced injected limit, as in B3-05b's limit tests. No wall-clock or large output needed.
  expect((await r.run({ limits: { ...r.deps.limits, textCodePoints: 2 } })).ending).toBe('limit');
  expect(r.views(1)).toEqual([{ card_id: 'c1' }]);
  expect(r.execute).toHaveBeenCalledTimes(1);
  expect(r.cards()).toHaveLength(1);
  r.noLeaks();
});

it('[AC-B3-05i#15][BR-AI-05][BR-AI-06] 第二张卡等待取号时中止，不泄露未下发引用且没有下一次模型调用', async () => {
  const r = harness([{ calls: [toolCall('synthetic-abort-delivery')] }]);
  r.execute.mockImplementation(async (_call, ctx) => {
    const refs = [0, 1].map((index) => cardReference(ctx, index));
    r.issued.push(...refs);
    return {
      kind: 'ok',
      cards: refs.map(() => notice()),
      modelView: refs,
      trace: {
        card_sources: refs.map((ref) => ({ card_id: ref, fields: { source: 'synthetic-source' } })),
      },
    };
  });
  const reserve = r.stream.cards.reserve.bind(r.stream.cards);
  let reservations = 0;
  vi.spyOn(r.stream.cards, 'reserve').mockImplementation(async (session, count) => {
    reservations += 1;
    if (reservations === 2) {
      await r.stream.manager.cancel(r.stream.start.ticket.runId, r.stream.start.ownerKey);
      await r.stream.time.by(500); // advance the injected cancellation poll, never real time
    }
    return reserve(session, count);
  });
  expect((await r.run()).ending).toBe('cancelled');
  await flush(); // allow the aborted body to record its trace after the manager's terminal
  expect(r.cards().map((frame) => frame.data['card_id'])).toEqual(['c1']);
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.traces).toHaveLength(1);
  r.noLeaks();
});
