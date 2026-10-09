// 进程内组合验收（B1-14b；规划/02 §14 千问行、§6.2；BR-AI-14 路由顺序与无模型降级）：经 platform 公共
// 出口取得登记表 model.qwen 策略，注入已实现的 HttpTransport → VendorGateway → ModelRouter；百炼故障
// 取自 QA-05a buildMappings('bailian') 的 429 / 503 / timeout 定义（只消费 status 与延迟），成功与恢复
// 用 kit 里明确标注的合成 SSE。fetch、Scheduler、Clock、计量去处全部注入：不联网、不 listen、不起
// WireMock、不读密钥。这里验证的只是进程内组合，不是生产装配、真实 WireMock 演练、关键词搜索出卡或
// 50302 HTTP 应答。期望值一律手写字面量。只用顶层 it（规划/11 §4.3）。
import { expect, it } from 'vitest';
import {
  bailianMapping,
  buildChain,
  fastQwenOverrides,
  fault,
  publicQwenPolicy,
  publicRegistryFactory,
  settle,
  sse,
} from './kit.ts';

it('[AC-B1-14b-007][QA-05a][02 §14 千问] 百炼故障定义与登记表 model.qwen 故障表现对应：429、503、超时；normal 是非流式 JSON', () => {
  const qwen = publicRegistryFactory()().entry('model.qwen');
  const pick = (scenario: 'timeout' | 'rate_limited' | 'server_error' | 'normal') => {
    const m = bailianMapping(scenario);
    return {
      method: m.request.method,
      path: m.request.urlPathPattern,
      status: m.response.status,
      delay: m.response.fixedDelayMilliseconds,
      contentType: m.response.headers?.['Content-Type'],
    };
  };
  expect({
    failureModes: [...qwen.failureModes],
    rateLimited: pick('rate_limited'),
    serverError: pick('server_error'),
    timeout: pick('timeout'),
    normal: pick('normal'),
  }).toEqual({
    failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
    rateLimited: {
      method: 'POST',
      path: '/bailian/compatible-mode/v1/chat/completions',
      status: 429,
      delay: undefined,
      contentType: undefined,
    },
    serverError: {
      method: 'POST',
      path: '/bailian/compatible-mode/v1/chat/completions',
      status: 503,
      delay: undefined,
      contentType: undefined,
    },
    timeout: {
      method: 'POST',
      path: '/bailian/compatible-mode/v1/chat/completions',
      status: 504,
      delay: 15000,
      contentType: undefined,
    },
    normal: {
      method: 'POST',
      path: '/bailian/compatible-mode/v1/chat/completions',
      status: 200,
      delay: undefined,
      contentType: 'application/json',
    },
  });
});

it('[AC-B1-14b-008][02 §14 千问][BR-AI-14] 429：主位 Flash 限流，切备位 Plus 成功；先 Flash 后 Plus，各发一次真实 HTTP 请求', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(),
    script: {
      'qwen-flash-2026-09-01': [fault('rate_limited')],
      'qwen-plus-2026-09-15': [sse('合成备位应答', 11, 7)],
    },
  });
  const outcome = await settle(chain.scheduler, chain.complete());
  expect({
    settled: outcome.settled,
    value: outcome.value,
    requests: chain.upstream.calls.map((c) => ({
      at: c.at,
      method: c.method,
      host: c.host,
      pathname: c.pathname,
      accept: c.accept,
      model: c.model,
      aborted: c.signal.aborted,
    })),
    meter: chain.onlineMeter.entries,
    offline: chain.offlineMeter.entries.length,
    alerts: chain.alerts,
  }).toEqual({
    settled: 'resolved',
    value: {
      kind: 'model',
      entryId: 'plus',
      model: 'qwen-plus-2026-09-15',
      events: [
        { t: 'text_delta', text: '合成备位应答' },
        { t: 'done', reason: 'stop' },
        { t: 'usage', input: 11, output: 7, cached: null },
      ],
      usage: { input_tokens: 11, output_tokens: 7 },
      attempts: [
        { entryId: 'flash', result: 'rate_limited', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    requests: [
      {
        at: 0,
        method: 'POST',
        host: 'dashscope.invalid',
        pathname: '/bailian/compatible-mode/v1/chat/completions',
        accept: 'text/event-stream',
        model: 'qwen-flash-2026-09-01',
        aborted: false,
      },
      {
        at: 0,
        method: 'POST',
        host: 'dashscope.invalid',
        pathname: '/bailian/compatible-mode/v1/chat/completions',
        accept: 'text/event-stream',
        model: 'qwen-plus-2026-09-15',
        aborted: false,
      },
    ],
    meter: [
      {
        vendor: 'qwen',
        purpose: 'online',
        use: null,
        model: 'qwen-plus-2026-09-15',
        input_tokens: 11,
        output_tokens: 7,
        recorded_at: new Date('2026-10-09T02:00:00.000Z'),
      },
    ],
    offline: 0,
    alerts: [],
  });
});

it('[AC-B1-14b-009][02 §14 千问][BR-AI-14] 503：主位 Flash 服务端错误，切备位 Plus 成功', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(),
    script: {
      'qwen-flash-2026-09-01': [fault('server_error')],
      'qwen-plus-2026-09-15': [sse('合成备位应答', 5, 3)],
    },
  });
  const outcome = await settle(chain.scheduler, chain.complete());
  expect({
    settled: outcome.settled,
    value: outcome.value,
    models: chain.upstream.calls.map((c) => c.model),
  }).toEqual({
    settled: 'resolved',
    value: {
      kind: 'model',
      entryId: 'plus',
      model: 'qwen-plus-2026-09-15',
      events: [
        { t: 'text_delta', text: '合成备位应答' },
        { t: 'done', reason: 'stop' },
        { t: 'usage', input: 5, output: 3, cached: null },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
      attempts: [
        { entryId: 'flash', result: 'server', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    models: ['qwen-flash-2026-09-01', 'qwen-plus-2026-09-15'],
  });
});

it('[AC-B1-14b-010][02 §14 千问][BR-AI-14] 超时：登记表覆盖的 2500 毫秒单次时限生效，到点中止 Flash 请求（不等 QA-05a 的 15000 毫秒）再切 Plus', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(fastQwenOverrides()),
    script: {
      'qwen-flash-2026-09-01': [fault('timeout')],
      'qwen-plus-2026-09-15': [sse('合成备位应答', 4, 2)],
    },
  });
  const outcome = chain.complete();
  await chain.scheduler.advance(2499);
  const before = {
    settled: outcome.settled,
    requests: chain.upstream.calls.length,
    flashAborted: chain.upstream.calls[0]?.signal.aborted,
  };
  await chain.scheduler.advance(1);
  expect({
    before,
    settled: outcome.settled,
    value: outcome.value,
    requests: chain.upstream.calls.map((c) => ({
      at: c.at,
      model: c.model,
      aborted: c.signal.aborted,
    })),
    now: chain.scheduler.now(),
    pendingWaits: chain.scheduler.pending,
  }).toEqual({
    before: { settled: 'pending', requests: 1, flashAborted: false },
    settled: 'resolved',
    value: {
      kind: 'model',
      entryId: 'plus',
      model: 'qwen-plus-2026-09-15',
      events: [
        { t: 'text_delta', text: '合成备位应答' },
        { t: 'done', reason: 'stop' },
        { t: 'usage', input: 4, output: 2, cached: null },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
      attempts: [
        { entryId: 'flash', result: 'timeout', elapsedMs: 2500 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    requests: [
      { at: 0, model: 'qwen-flash-2026-09-01', aborted: true },
      { at: 2500, model: 'qwen-plus-2026-09-15', aborted: false },
    ],
    now: 2500,
    pendingWaits: 0,
  });
});

it('[AC-B1-14b-011][02 §14 千问][BR-AI-14] 主备都失败（Flash 429、Plus 503）→ ModelOutcome.degraded(models_failed)，不计量', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(),
    script: {
      'qwen-flash-2026-09-01': [fault('rate_limited')],
      'qwen-plus-2026-09-15': [fault('server_error')],
    },
  });
  const outcome = await settle(chain.scheduler, chain.complete());
  expect({
    settled: outcome.settled,
    value: outcome.value,
    models: chain.upstream.calls.map((c) => c.model),
    meter: chain.onlineMeter.entries.length,
  }).toEqual({
    settled: 'resolved',
    value: {
      kind: 'degraded',
      reason: 'models_failed',
      attempts: [
        { entryId: 'flash', result: 'rate_limited', elapsedMs: 0 },
        { entryId: 'plus', result: 'server', elapsedMs: 0 },
      ],
    },
    models: ['qwen-flash-2026-09-01', 'qwen-plus-2026-09-15'],
    meter: 0,
  });
});

it('[AC-B1-14b-012][02 §14 千问][BR-AI-14] 主备都超时 → degraded(models_failed)，各在 2500 毫秒被中止', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(fastQwenOverrides()),
    script: {
      'qwen-flash-2026-09-01': [fault('timeout')],
      'qwen-plus-2026-09-15': [fault('timeout')],
    },
  });
  const outcome = chain.complete();
  await chain.scheduler.advance(2500);
  const middle = outcome.settled;
  await chain.scheduler.advance(2500);
  expect({
    middle,
    settled: outcome.settled,
    value: outcome.value,
    requests: chain.upstream.calls.map((c) => ({
      at: c.at,
      model: c.model,
      aborted: c.signal.aborted,
    })),
    pendingWaits: chain.scheduler.pending,
  }).toEqual({
    middle: 'pending',
    settled: 'resolved',
    value: {
      kind: 'degraded',
      reason: 'models_failed',
      attempts: [
        { entryId: 'flash', result: 'timeout', elapsedMs: 2500 },
        { entryId: 'plus', result: 'timeout', elapsedMs: 2500 },
      ],
    },
    requests: [
      { at: 0, model: 'qwen-flash-2026-09-01', aborted: true },
      { at: 2500, model: 'qwen-plus-2026-09-15', aborted: true },
    ],
    pendingWaits: 0,
  });
});

it('[AC-B1-14b-013][02 §14 千问 当日预算用完][BR-AI-16] 预算耗尽 → 直接 degraded(budget)，不发任何上游请求、不计量', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(),
    script: {
      'qwen-flash-2026-09-01': [sse('不应发出', 1, 1)],
      'qwen-plus-2026-09-15': [sse('不应发出', 1, 1)],
    },
    budgetExhausted: () => true,
  });
  const outcome = await settle(chain.scheduler, chain.complete());
  expect({
    settled: outcome.settled,
    value: outcome.value,
    requests: chain.upstream.calls.length,
    meter: chain.onlineMeter.entries.length,
  }).toEqual({
    settled: 'resolved',
    value: { kind: 'degraded', reason: 'budget', attempts: [] },
    requests: 0,
    meter: 0,
  });
});

it('[AC-B1-14b-014][02 §6.2 熔断][02 §14 千问] 每条目独立熔断：Flash 打开后不发请求、Plus 照常；openMs 前不重试，到点恢复并成功', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(fastQwenOverrides()),
    script: {
      'qwen-flash-2026-09-01': [
        fault('rate_limited'),
        fault('rate_limited'),
        sse('合成主位恢复', 9, 4),
      ],
      'qwen-plus-2026-09-15': [
        sse('合成备位应答', 2, 1),
        sse('合成备位应答', 2, 1),
        sse('合成备位应答', 2, 1),
        sse('合成备位应答', 2, 1),
      ],
    },
  });
  const attemptsOf = async () => {
    const o = await settle(chain.scheduler, chain.complete());
    const v = o.value;
    return v === undefined ? o.settled : { kind: v.kind, attempts: v.attempts };
  };
  const initial = chain.router.breakerState('flash');
  const first = await attemptsOf();
  const second = await attemptsOf();
  const opened = {
    flash: chain.router.breakerState('flash'),
    plus: chain.router.breakerState('plus'),
  };
  const third = await attemptsOf();
  await chain.scheduler.advance(11_999);
  const justBefore = {
    flash: chain.router.breakerState('flash'),
    outcome: await attemptsOf(),
  };
  await chain.scheduler.advance(1);
  const atBoundaryState = chain.router.breakerState('flash');
  const recovered = await settle(chain.scheduler, chain.complete());
  expect({
    initial,
    first,
    second,
    opened,
    third,
    justBefore,
    atBoundaryState,
    recovered: recovered.value,
    flashRequestsAt: chain.upstream.callsFor('qwen-flash-2026-09-01').map((c) => c.at),
    plusRequestsAt: chain.upstream.callsFor('qwen-plus-2026-09-15').map((c) => c.at),
    plusState: chain.router.breakerState('plus'),
  }).toEqual({
    initial: 'closed',
    first: {
      kind: 'model',
      attempts: [
        { entryId: 'flash', result: 'rate_limited', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    second: {
      kind: 'model',
      attempts: [
        { entryId: 'flash', result: 'rate_limited', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    opened: { flash: 'open', plus: 'closed' },
    third: {
      kind: 'model',
      attempts: [
        { entryId: 'flash', result: 'circuit_open', elapsedMs: 0 },
        { entryId: 'plus', result: 'ok', elapsedMs: 0 },
      ],
    },
    justBefore: {
      flash: 'open',
      outcome: {
        kind: 'model',
        attempts: [
          { entryId: 'flash', result: 'circuit_open', elapsedMs: 0 },
          { entryId: 'plus', result: 'ok', elapsedMs: 0 },
        ],
      },
    },
    atBoundaryState: 'closed',
    recovered: {
      kind: 'model',
      entryId: 'flash',
      model: 'qwen-flash-2026-09-01',
      events: [
        { t: 'text_delta', text: '合成主位恢复' },
        { t: 'done', reason: 'stop' },
        { t: 'usage', input: 9, output: 4, cached: null },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
      attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
    },
    flashRequestsAt: [0, 0, 12000],
    plusRequestsAt: [0, 0, 0, 11999],
    plusState: 'closed',
  });
});

it('[AC-B1-14b-015][02 §6.2 熔断][02 §14 千问] 主备两条目都打开 → 不发请求，直接 degraded(models_failed)，两条目各记 circuit_open', async () => {
  const chain = buildChain({
    policy: publicQwenPolicy(fastQwenOverrides()),
    script: {
      'qwen-flash-2026-09-01': [fault('rate_limited'), fault('rate_limited')],
      'qwen-plus-2026-09-15': [fault('server_error'), fault('server_error')],
    },
  });
  await settle(chain.scheduler, chain.complete());
  await settle(chain.scheduler, chain.complete());
  const states = {
    flash: chain.router.breakerState('flash'),
    plus: chain.router.breakerState('plus'),
  };
  const before = chain.upstream.calls.length;
  const outcome = await settle(chain.scheduler, chain.complete());
  expect({
    states,
    before,
    after: chain.upstream.calls.length,
    value: outcome.value,
  }).toEqual({
    states: { flash: 'open', plus: 'open' },
    before: 4,
    after: 4,
    value: {
      kind: 'degraded',
      reason: 'models_failed',
      attempts: [
        { entryId: 'flash', result: 'circuit_open', elapsedMs: 0 },
        { entryId: 'plus', result: 'circuit_open', elapsedMs: 0 },
      ],
    },
  });
});
