// B3-03b RunManager life cycle: meta first, heartbeat, time limit counted from acceptance, guard
// (agent.enabled off / consent withdrawn), disconnect grace, body endings, exactly one terminal
// frame, and the tail order settle → registry.finish → terminal frame (规划/04 §8.1–8.2, 02 §9.2,
// BR-AI-12, BR-AI-13, BR-AI-14 细则「单轮时限」, BR-AI-23 细则「受理记录与收尾」). Time only moves
// through ManualTime; expected values are written here or read from the contract fixtures.
import { expect, it } from 'vitest';
import { StreamProtocolError } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import {
  runConfigDefaults,
  type RunBody,
  type RunBodyResult,
  type RunConfig,
  type RunContext,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  IDS,
  TIMEOUT_TEXT,
  errorData,
  fixtureCardFrame,
  fixtureLines,
  frameIsValid,
  framesOf,
  isTerminal,
  never,
  parseSse,
  rig,
  streamProblems,
  ticketOf,
  unnumbered,
  type Frame,
  type Rig,
} from './kit.ts';

const BASE: RunConfig = {
  maxRunMs: 60_000,
  heartbeatMs: 15_000,
  disconnectGraceMs: 30_000,
  guardPollMs: 5_000,
  signalPollMs: 500,
};
const LIMITS_COPY = {
  memberDaily: 30,
  guestDaily: 3,
  guestIpDaily: 30,
  perMinute: 10,
  maxRounds: 30,
};

function kinds(r: Rig): string[] {
  return (parseSse(r.sink.chunks) ?? []).map((l) => ('event' in l ? l.event : 'ping'));
}
/** Meta with duplicate=false is the same as without it (schema); other values stay. */
function plain(frames: Frame[]): Frame[] {
  return frames.map((f) =>
    f.event === 'meta' && f.data['duplicate'] === false
      ? {
          ...f,
          data: Object.fromEntries(Object.entries(f.data).filter(([k]) => k !== 'duplicate')),
        }
      : f,
  );
}
function track<T>(p: Promise<T>): { done: () => boolean } {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { done: () => settled };
}
/** Starts a body that captures its context, writes `before`, then never returns. */
function hanging(r: Rig, before: (ctx: RunContext) => Promise<void>) {
  const box: { ctx?: RunContext } = {};
  const body: RunBody = async (ctx) => {
    box.ctx = ctx;
    await before(ctx);
    return never<RunBodyResult>();
  };
  const p = r.manager.start(r.start, body);
  return { p, box, state: track(p) };
}

it('[04 §8.1–8.2][BR-AI-23] 正常：先登记、先写 meta 再调 body，输出与 normal 样例逐帧一致，收尾 settle → finish → done', async () => {
  const r = rig({ config: BASE, quotaLeft: 29, cardFirsts: [1, 4] });
  let chunksAtBody = -1;
  const body: RunBody = async (ctx) => {
    chunksAtBody = r.sink.chunks.length;
    const steps = fixtureLines('normal').filter((l): l is Frame => 'event' in l);
    for (const f of steps.slice(1, -1)) {
      const d = f.data as {
        tool: string;
        phase: 'start' | 'end' | 'failed';
        display_text: string;
        delta: string;
        items: { text: string; send_text: string }[];
      };
      if (f.event === 'tool.status') ctx.toolStatus(d.tool, d.phase, d.display_text);
      if (f.event === 'text.delta') ctx.text(d.delta);
      if (f.event === 'card') await ctx.card(unnumbered(f.data));
      if (f.event === 'suggestions') ctx.suggestions(d.items);
    }
    return { kind: 'done', finishReason: 'stop' };
  };
  const p = r.manager.start(r.start, body);
  expect(await r.time.drive(p, 1_000)).toBe(true);
  const final = await p;
  const frames = plain(framesOf(r.sink.chunks));
  expect(frames).toEqual(fixtureLines('normal').filter((l) => 'event' in l));
  expect(streamProblems(frames)).toEqual([]);
  expect(chunksAtBody).toBe(1);
  expect(r.registry.registered).toEqual([
    { runId: IDS.run, sessionId: IDS.session, ownerKey: 'u:u-demo-1' },
  ]);
  expect(r.cards.calls).toEqual([
    { sessionId: IDS.session, count: 3 },
    { sessionId: IDS.session, count: 2 },
  ]);
  expect(r.admission.calls).toEqual([
    {
      ticket: ticketOf(0, 60_000),
      outcome: { ending: 'stop', cardsDelivered: 2 },
      limits: LIMITS_COPY,
    },
  ]);
  const terminal = { event: 'done', data: { finish_reason: 'stop', quota_left: 29 } };
  expect(r.registry.finished).toEqual([{ runId: IDS.run, terminal }]);
  const tail = [
    'facts:saved:stop:2',
    'settle',
    'settle:done',
    'finish',
    'finish:done',
    'write:done',
  ];
  expect(r.log.filter((x) => tail.includes(x))).toEqual(tail);
  const facts = r.registry.factLog.map((f) => [f.runId, f.facts]);
  expect(facts).toContainEqual([IDS.run, { ending: null, cardsDelivered: 1 }]);
  expect(facts).toContainEqual([IDS.run, { ending: null, cardsDelivered: 2 }]);
  expect(facts[facts.length - 1]).toEqual([IDS.run, { ending: 'stop', cardsDelivered: 2 }]);
  expect(final).toEqual({ terminal, ending: 'stop', cardsDelivered: 2 });
});

it('[04 §8.1][02 §9.2][BR-AI-14][BR-AI-12][BR-AI-13] 默认值：心跳 15 秒、单轮时限 20 秒、断线宽限 60 秒、守卫轮询 ≤10 秒', () => {
  const d = runConfigDefaults();
  expect([d.heartbeatMs, d.maxRunMs, d.disconnectGraceMs]).toEqual([15_000, 20_000, 60_000]);
  expect(Number.isSafeInteger(d.guardPollMs) && d.guardPollMs >= 1 && d.guardPollMs <= 10_000).toBe(
    true,
  );
  expect(Number.isSafeInteger(d.signalPollMs) && d.signalPollMs >= 1).toBe(true);
});

function heartbeatConfig(h: number): RunConfig {
  return { ...BASE, heartbeatMs: h, maxRunMs: 10 * h, disconnectGraceMs: 10 * h };
}

it.each([15_000, 4_000])(
  '[04 §8.1] 心跳 heartbeatMs=%i：空闲满 heartbeatMs 写一次 `: ping`（不占 seq），终止帧后不再发',
  async (h) => {
    const r = rig({ config: heartbeatConfig(h) });
    const p = r.manager.start(r.start, async (ctx) => {
      await r.time.sleep(2 * h + 10);
      ctx.text('稍等，正在查询');
      return { kind: 'done', finishReason: 'stop' };
    });
    await r.time.to(h - 1);
    expect(kinds(r)).toEqual(['meta']);
    await r.time.to(h);
    expect(kinds(r)).toEqual(['meta', 'ping']);
    expect(r.sink.chunks[1]).toBe(': ping\n\n');
    await r.time.to(2 * h - 1);
    expect(kinds(r)).toEqual(['meta', 'ping']);
    await r.time.to(2 * h + 10);
    await p;
    expect(kinds(r)).toEqual(['meta', 'ping', 'ping', 'text.delta', 'done']);
    expect(framesOf(r.sink.chunks).map((f) => f.id)).toEqual([1, 2, 3]);
    await r.time.by(5 * h);
    expect(kinds(r)).toEqual(['meta', 'ping', 'ping', 'text.delta', 'done']);
  },
);

it.each([15_000, 4_000])(
  '[04 §8.1] 心跳 heartbeatMs=%i：一直有帧写入时任意两次写入的间隔都不超过 heartbeatMs，帧序与 seq 不受心跳影响',
  async (h) => {
    const r = rig({ config: heartbeatConfig(h) });
    const p = r.manager.start(r.start, async (ctx) => {
      for (let i = 1; i <= 5; i += 1) {
        await r.time.sleep(h - 1);
        ctx.text(`第 ${i} 段`);
      }
      return { kind: 'done', finishReason: 'stop' };
    });
    expect(await r.time.drive(p, 6 * h)).toBe(true);
    const at = r.sink.attempts.map((a) => a.t);
    expect(at.slice(1).filter((t, i) => t - at[i]! > h)).toEqual([]);
    const frames = framesOf(r.sink.chunks);
    expect(frames.map((f) => [f.event, f.id])).toEqual([
      ['meta', 1],
      ['text.delta', 2],
      ['text.delta', 3],
      ['text.delta', 4],
      ['text.delta', 5],
      ['text.delta', 6],
      ['done', 7],
    ]);
  },
);

it.each([
  { maxRunMs: 20_000, acceptedBeforeMs: 5_000, deadline: 15_000, card: true },
  { maxRunMs: 9_000, acceptedBeforeMs: 2_000, deadline: 7_000, card: false },
])(
  '[BR-AI-14 细则「单轮时限」] maxRunMs=$maxRunMs、受理早于 start $acceptedBeforeMs ms：从受理时刻起算到点中止（reason timeout），已下发卡片保留，写 agent.timeout 与 done timeout，之后 ctx 调用丢弃',
  async (c) => {
    const r = rig({
      config: { ...BASE, maxRunMs: c.maxRunMs },
      acceptedBeforeMs: c.acceptedBeforeMs,
    });
    const run = hanging(r, async (ctx) => {
      if (c.card) await ctx.card(unnumbered(fixtureCardFrame('product_list')));
      ctx.text('先看这些');
    });
    await r.time.to(c.deadline - 1);
    expect(run.box.ctx?.signal.aborted).toBe(false);
    expect(run.state.done()).toBe(false);
    await r.time.to(c.deadline);
    expect(run.box.ctx?.signal.reason).toBe('timeout');
    expect(run.state.done()).toBe(true);
    const frames = framesOf(r.sink.chunks);
    expect(frames.map((f) => f.event)).toEqual(
      c.card
        ? ['meta', 'card', 'text.delta', 'text.delta', 'done']
        : ['meta', 'text.delta', 'text.delta', 'done'],
    );
    expect(frames.slice(-2).map((f) => f.data)).toEqual([
      { seq: c.card ? 4 : 3, delta: TIMEOUT_TEXT },
      { finish_reason: 'timeout', quota_left: 17 },
    ]);
    const cards = c.card ? 1 : 0;
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: 'timeout', cardsDelivered: cards },
    ]);
    expect(await run.p).toEqual({
      terminal: { event: 'done', data: { finish_reason: 'timeout', quota_left: 17 } },
      ending: 'timeout',
      cardsDelivered: cards,
    });
    const written = r.sink.attempts.length;
    const ctx = run.box.ctx!;
    try {
      ctx.text('迟到的文字');
      ctx.toolStatus('search_products', 'end', '已查询京东商品');
      await ctx.card(unnumbered(fixtureCardFrame('rebate_quote')));
    } catch {
      // discarded either way; nothing may be written
    }
    await r.time.by(c.maxRunMs);
    expect(r.sink.attempts.slice(written)).toEqual([]);
    expect(kinds(r).slice(-1)).toEqual(['done']);
    expect(r.admission.calls).toHaveLength(1);
  },
);

it.each([
  { code: 30501 as const, ending: 'disabled', poll: 10_000 },
  { code: 30501 as const, ending: 'disabled', poll: 2_500 },
  { code: 10004 as const, ending: 'consent_withdrawn', poll: 10_000 },
  { code: 10004 as const, ending: 'consent_withdrawn', poll: 2_500 },
])(
  '[BR-AI-12][BR-AI-13] 守卫返回 $code、guardPollMs=$poll：一个轮询间隔内中止并写 error（retryable=false、fallback=null），结局 $ending，之后不再轮询',
  async (c) => {
    const r = rig({ config: { ...BASE, guardPollMs: c.poll, maxRunMs: 120_000 } });
    const run = hanging(r, async (ctx) => void ctx.text('正在找'));
    const flip = 2 * c.poll + 333;
    await r.time.to(flip);
    expect(run.box.ctx?.signal.aborted).toBe(false);
    r.guard.answer = { code: c.code };
    await r.time.to(flip + c.poll);
    expect(run.box.ctx?.signal.reason).toBe(c.ending);
    expect(run.state.done()).toBe(true);
    const last = framesOf(r.sink.chunks).slice(-1)[0]!;
    const data = { code: c.code, msg: `错误提示-${c.code}`, retryable: false, fallback: null };
    expect([last.event, errorData(last.data)]).toEqual(['error', data]);
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: c.ending, cardsDelivered: 0 },
    ]);
    const final = await run.p;
    expect([final.ending, final.terminal?.event, errorData({ ...final.terminal?.data })]).toEqual([
      c.ending,
      'error',
      data,
    ]);
    const checks = r.guard.checks;
    await r.time.by(5 * c.poll);
    expect(r.guard.checks).toBe(checks);
    expect(framesOf(r.sink.chunks).filter(isTerminal)).toHaveLength(1);
  },
);

it('[BR-AI-12] 守卫本身抛错时继续运行，下一轮再查：抛错期间 run 照常结束', async () => {
  const r = rig({ config: { ...BASE, guardPollMs: 2_000 } });
  r.guard.throws = true;
  const p = r.manager.start(r.start, async () => {
    await r.time.sleep(3 * 2_000 + 1);
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(await r.time.drive(p, 10_000)).toBe(true);
  expect((await p).ending).toBe('stop');
  expect(r.guard.checks).toBeGreaterThanOrEqual(3);
  expect(framesOf(r.sink.chunks).slice(-1)[0]?.data).toEqual({
    finish_reason: 'stop',
    quota_left: 17,
  });
});

it('[BR-AI-13] 守卫抛错之后恢复并返回 10004：在恢复后一个 guardPollMs 内终止', async () => {
  const r = rig({ config: { ...BASE, guardPollMs: 2_000 } });
  r.guard.throws = true;
  const run = hanging(r, async () => undefined);
  await r.time.to(5_000);
  expect(run.state.done()).toBe(false);
  r.guard.throws = false;
  r.guard.answer = { code: 10004 };
  await r.time.to(7_000);
  expect(run.box.ctx?.signal.reason).toBe('consent_withdrawn');
  expect((await run.p).ending).toBe('consent_withdrawn');
});

it.each([
  { grace: 3_000, maxRunMs: 20_000 },
  { grace: 8_000, maxRunMs: 30_000 },
])(
  '[02 §9.2 取消与断线] disconnectGraceMs=$grace：sink 关闭后满宽限中止（reason disconnected），之后不向连接写任何东西，结局 disconnected；settle 完成后仍经 registry.finish 保存一个合法终止帧（不发送）',
  async (c) => {
    const r = rig({ config: { ...BASE, disconnectGraceMs: c.grace, maxRunMs: c.maxRunMs } });
    const run = hanging(r, (ctx) => ctx.card(unnumbered(fixtureCardFrame('product_list'))));
    await r.time.to(1_000);
    r.sink.close();
    await r.time.to(1_000 + c.grace - 1);
    expect(run.box.ctx?.signal.aborted).toBe(false);
    await r.time.to(1_000 + c.grace);
    expect(run.box.ctx?.signal.reason).toBe('disconnected');
    expect(run.state.done()).toBe(true);
    run.box.ctx?.text('断线之后');
    await r.time.by(c.maxRunMs);
    expect(r.sink.attempts.filter((a) => a.t >= 1_000 + c.grace)).toEqual([]);
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: 'disconnected', cardsDelivered: 1 },
    ]);
    const final = await run.p;
    expect([final.ending, final.cardsDelivered]).toEqual(['disconnected', 1]);
    expect(frameIsValid({ event: final.terminal?.event, id: 1, data: final.terminal?.data })).toBe(
      true,
    );
    expect(await r.registry.final(IDS.run)).toEqual(final.terminal);
    expect(r.log.indexOf('settle:done')).toBeLessThan(r.log.indexOf('finish'));
    expect(framesOf(r.sink.chunks).filter(isTerminal)).toEqual([]);
  },
);

it('[02 §9.2] 宽限期内 run 正常结束：照常结算，写入失败静默，signal 不中止', async () => {
  const r = rig({ config: { ...BASE, disconnectGraceMs: 3_000, maxRunMs: 20_000 } });
  let signal: AbortSignal | undefined;
  const p = r.manager.start(r.start, async (ctx) => {
    signal = ctx.signal;
    ctx.text('第一段');
    await r.time.sleep(2_500);
    ctx.text('第二段');
    return { kind: 'done', finishReason: 'stop' };
  });
  await r.time.to(1_000);
  r.sink.close();
  expect(await r.time.drive(p, 3_900)).toBe(true);
  expect(await p).toEqual({
    terminal: { event: 'done', data: { finish_reason: 'stop', quota_left: 17 } },
    ending: 'stop',
    cardsDelivered: 0,
  });
  expect(signal?.aborted).toBe(false);
  expect(r.admission.calls).toHaveLength(1);
});

it('[02 §9.2][BR-AI-14] 默认值下断线宽限（60 秒）到不了：先以单轮时限 timeout 结束', async () => {
  const r = rig({ config: runConfigDefaults(), acceptedBeforeMs: 5_000 });
  const run = hanging(r, async (ctx) => void ctx.text('正在找'));
  await r.time.to(1_000);
  r.sink.close();
  await r.time.to(14_999);
  expect(run.box.ctx?.signal.aborted).toBe(false);
  await r.time.to(15_000);
  expect(run.box.ctx?.signal.reason).toBe('timeout');
  expect((await run.p).ending).toBe('timeout');
});

it('[BR-AI-23][BR-AI-15] body 抛出未预期异常：写 error 50001（retryable=true），结局 server_error', async () => {
  const r = rig({ config: BASE });
  const p = r.manager.start(r.start, async (ctx) => {
    ctx.text('正在找');
    throw new Error('boom');
  });
  expect(await r.time.drive(p, 1_000)).toBe(true);
  const last = framesOf(r.sink.chunks).slice(-1)[0]!;
  expect([last.event, errorData(last.data)]).toEqual([
    'error',
    { code: 50001, msg: '错误提示-50001', retryable: true, fallback: null },
  ]);
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([
    { ending: 'server_error', cardsDelivered: 0 },
  ]);
});

it('[BR-AI-14][BR-AI-15] body 返回 error 50302：原样写出，结局 server_error', async () => {
  const r = rig({ config: BASE });
  const error = {
    code: 50302,
    msg: 'AI 暂不可用，可以先用搜索找货',
    retryable: true,
    fallback: 'search_page',
    fallback_q: '纯牛奶',
  };
  const p = r.manager.start(r.start, async () => ({
    kind: 'error',
    error: structuredClone(error),
  }));
  expect(await r.time.drive(p, 1_000)).toBe(true);
  expect(framesOf(r.sink.chunks).slice(-1)[0]).toEqual({ event: 'error', id: 2, data: error });
  expect((await p).ending).toBe('server_error');
  expect(r.admission.calls.map((x) => x.outcome.ending)).toEqual(['server_error']);
});

it('[BR-AI-15] body 返回 done safety 且 ending=input_review_timeout：写 done safety，结算结局用覆盖值', async () => {
  const r = rig({ config: BASE });
  const p = r.manager.start(r.start, async () => ({
    kind: 'done',
    finishReason: 'safety',
    ending: 'input_review_timeout',
  }));
  expect(await r.time.drive(p, 1_000)).toBe(true);
  expect(framesOf(r.sink.chunks).slice(-1)[0]?.data).toEqual({
    finish_reason: 'safety',
    quota_left: 17,
  });
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([
    { ending: 'input_review_timeout', cardsDelivered: 0 },
  ]);
});

it('[04 §8.2] 不合法的卡片：ctx.card 以 StreamProtocolError(invalid_frame) 拒绝，run 继续，终止帧只有一个', async () => {
  const r = rig({ config: BASE });
  let refused: unknown;
  let delivered = -1;
  const p = r.manager.start(r.start, async (ctx) => {
    ctx.text('第一段');
    refused = await ctx
      .card({
        type: 'notice',
        schema_version: 1,
        data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
        fallback_text: '',
      })
      .then(
        () => 'resolved',
        (e: unknown) => e,
      );
    delivered = ctx.cardsDelivered;
    ctx.text('第二段');
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(await r.time.drive(p, 1_000)).toBe(true);
  expect(refused).toBeInstanceOf(StreamProtocolError);
  expect((refused as StreamProtocolError).code).toBe('invalid_frame');
  expect(delivered).toBe(0);
  expect(framesOf(r.sink.chunks).map((f) => f.event)).toEqual([
    'meta',
    'text.delta',
    'text.delta',
    'done',
  ]);
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([{ ending: 'stop', cardsDelivered: 0 }]);
});

const BODY_REASONS = [
  'stop',
  'limit',
  'budget',
  'error',
  'auth_required',
  'safety',
  'fallback',
] as const;
it.each([...BODY_REASONS, 'cancelled', 'timeout'] as const)(
  '[04 §8.2][B3-03a 范围外条目] finish_reason=%s 能经 RunManager 写出 done 并通过契约校验',
  async (reason) => {
    const r = rig({ config: { ...BASE, maxRunMs: 5_000 } });
    const body: RunBody = async (ctx) => {
      ctx.text('结果如下');
      if (reason === 'cancelled' || reason === 'timeout') return never();
      return { kind: 'done', finishReason: reason };
    };
    const p = r.manager.start(r.start, body);
    if (reason === 'cancelled') {
      await r.time.to(1_000);
      expect(await r.manager.cancel(IDS.run, 'u:u-demo-1')).toBe('ok');
    }
    expect(await r.time.drive(p, 6_000)).toBe(true);
    const frames = framesOf(r.sink.chunks);
    expect(frames.slice(-1)[0]?.data).toEqual({ finish_reason: reason, quota_left: 17 });
    expect(frameIsValid(frames.slice(-1)[0])).toBe(true);
    expect(streamProblems(frames)).toEqual([]);
    expect(frames.filter(isTerminal)).toHaveLength(1);
    if (reason !== 'error') expect((await p).ending).toBe(reason);
  },
);

it('[02 §9.2][BR-AI-23] 晚到：已因取消结束后 body 才返回 done stop，结果被忽略', async () => {
  const r = rig({ config: BASE });
  const p = r.manager.start(r.start, async () => {
    await r.time.sleep(5_000);
    return { kind: 'done', finishReason: 'stop' };
  });
  await r.time.to(1_000);
  expect(await r.manager.cancel(IDS.run, 'u:u-demo-1')).toBe('ok');
  expect(await r.time.drive(p, 4_000)).toBe(true);
  await r.time.to(8_000);
  const terminals = framesOf(r.sink.chunks).filter(isTerminal);
  expect(terminals.map((f) => f.data)).toEqual([{ finish_reason: 'cancelled', quota_left: 17 }]);
  expect(r.admission.calls.map((x) => x.outcome.ending)).toEqual(['cancelled']);
  expect((await p).ending).toBe('cancelled');
});

it('[BR-AI-23 细则「受理记录与收尾」] 收尾逐步完成：运行事实已记下才 settle，settle 未完成不开始 finish，finish 未完成不写终止帧、start 不完成', async () => {
  const r = rig({ config: BASE, quotaLeft: 8 });
  r.admission.barrier.hold();
  r.registry.finishBarrier.hold();
  const p = r.manager.start(r.start, async (ctx) => {
    await ctx.card(unnumbered(fixtureCardFrame('product_list')));
    return { kind: 'done', finishReason: 'stop' };
  });
  const state = track(p);
  await r.time.by(100);
  expect(r.log.filter((x) => x.startsWith('facts:saved:stop'))).toEqual(['facts:saved:stop:1']);
  expect(r.log.indexOf('facts:saved:stop:1')).toBeLessThan(r.log.indexOf('settle'));
  expect(r.log).not.toContain('finish');
  expect(kinds(r)).toEqual(['meta', 'card']);
  expect(state.done()).toBe(false);
  r.admission.barrier.release();
  await r.time.by(100);
  expect(r.log).toContain('finish');
  expect(r.log).not.toContain('finish:done');
  expect(kinds(r)).toEqual(['meta', 'card']);
  expect(state.done()).toBe(false);
  r.registry.finishBarrier.release();
  await r.time.by(100);
  expect(kinds(r)).toEqual(['meta', 'card', 'done']);
  expect(framesOf(r.sink.chunks)[2]?.data).toEqual({ finish_reason: 'stop', quota_left: 8 });
  expect(state.done()).toBe(true);
  expect(r.log.indexOf('finish:done')).toBeLessThan(r.log.indexOf('write:done'));
});

it.each([
  { code: 30501 as const, ending: 'disabled' },
  { code: 10004 as const, ending: 'consent_withdrawn' },
])(
  '[BR-AI-12][BR-AI-13] 已成功下发一张卡后守卫返回 $code：恰好一个 error $code 终止帧，结算与 RunFinal 都是 {$ending, 1}',
  async (c) => {
    const r = rig({ config: { ...BASE, guardPollMs: 2_000 } });
    const run = hanging(r, (ctx) => ctx.card(unnumbered(fixtureCardFrame('rebate_quote'))));
    await r.time.to(3_000);
    expect(kinds(r)).toEqual(['meta', 'card']);
    r.guard.answer = { code: c.code };
    await r.time.to(5_000);
    expect(run.state.done()).toBe(true);
    const terminals = framesOf(r.sink.chunks).filter(isTerminal);
    expect(terminals.map((f) => [f.event, f.id, errorData(f.data)])).toEqual([
      ['error', 3, { code: c.code, msg: `错误提示-${c.code}`, retryable: false, fallback: null }],
    ]);
    expect(r.admission.calls.map((x) => x.outcome)).toEqual([
      { ending: c.ending, cardsDelivered: 1 },
    ]);
    const final = await run.p;
    expect([final.ending, final.cardsDelivered]).toEqual([c.ending, 1]);
    expect(r.registry.factLog.slice(-1)).toEqual([
      { runId: IDS.run, facts: { ending: c.ending, cardsDelivered: 1 } },
    ]);
  },
);

it('[BR-AI-23 细则「受理记录与收尾」] 首帧 meta 写入即失败（受理后客户端已断开）：不写出任何帧，仍登记结局、恰好一次 settle，并保存合法终态', async () => {
  const r = rig({ config: BASE });
  r.sink.failAt = 1;
  const p = r.manager.start(r.start, async (ctx) => {
    ctx.text('不应送达');
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(await r.time.drive(p, 70_000)).toBe(true);
  const final = await p;
  expect(r.sink.chunks).toEqual([]);
  expect(r.admission.calls).toHaveLength(1);
  const call = r.admission.calls[0]!;
  expect(call.outcome.cardsDelivered).toBe(0);
  expect([final.ending, final.cardsDelivered]).toEqual([call.outcome.ending, 0]);
  expect(await r.registry.facts(IDS.run)).toEqual({
    ending: call.outcome.ending,
    cardsDelivered: 0,
  });
  expect(r.log.indexOf(`facts:saved:${call.outcome.ending}:0`)).toBeLessThan(
    r.log.indexOf('settle'),
  );
  expect(frameIsValid({ event: final.terminal?.event, id: 1, data: final.terminal?.data })).toBe(
    true,
  );
  expect(await r.registry.final(IDS.run)).toEqual(final.terminal);
  expect(r.log.indexOf('settle:done')).toBeLessThan(r.log.indexOf('finish'));
});

it('[BR-AI-23 细则「受理记录与收尾」] 事实保存未完成：ctx.card 不完成；终止事实未保存完不进入 settle，放行后才读得到', async () => {
  const r = rig({ config: { ...BASE, guardPollMs: 2_000 } });
  r.registry.factsBarrier.hold();
  let cardDone = false;
  const run = hanging(r, async (ctx) => {
    await ctx.card(unnumbered(fixtureCardFrame('product_list')));
    cardDone = true;
  });
  await r.time.to(500);
  expect(kinds(r)).toEqual(['meta', 'card']);
  expect(cardDone).toBe(false);
  expect(await r.registry.facts(IDS.run)).toBeNull();
  r.registry.factsBarrier.release();
  await r.time.to(1_000);
  expect(cardDone).toBe(true);
  expect(await r.registry.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 1 });
  r.registry.factsBarrier.hold();
  r.guard.answer = { code: 10004 };
  await r.time.to(4_000);
  expect(r.log).toContain('facts:consent_withdrawn:1');
  expect(r.admission.calls).toEqual([]);
  expect(await r.registry.facts(IDS.run)).toEqual({ ending: null, cardsDelivered: 1 });
  expect(run.state.done()).toBe(false);
  r.registry.factsBarrier.release();
  await r.time.to(4_100);
  expect(await r.registry.facts(IDS.run)).toEqual({
    ending: 'consent_withdrawn',
    cardsDelivered: 1,
  });
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([
    { ending: 'consent_withdrawn', cardsDelivered: 1 },
  ]);
  expect(run.state.done()).toBe(true);
});
