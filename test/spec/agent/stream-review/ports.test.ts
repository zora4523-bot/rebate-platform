import { afterEach, expect, it, vi } from 'vitest';
import { createOutputGuard } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { createStreamReview } from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import type { StreamReviewOptions } from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { input, notice, setup, toolCall } from '../orchestrator-core/kit.ts';
import { credentials, endpoint, fixture, flush, requestContent, type Answer } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

const unavailable = {
  kind: 'refuse',
  textKey: 'agent.refuse.safety_unavailable',
  finishReason: 'safety',
  ending: 'input_review_timeout',
};

it.each([
  { credentials: undefined },
  { credentials: { ...credentials, accessKeyId: '' } },
  { credentials: { ...credentials, accessKeySecret: '' } },
  { endpoint: undefined },
  { endpoint: '' },
  { appEnv: 'local' },
  { appEnv: 'test' },
] satisfies Partial<StreamReviewOptions>[])(
  '[AC-B3-03m#6][BR-AI-18] 缺配置或非生产环境 fail-close 且零网络：%j',
  async (patch) => {
    const f = fixture(['none'], patch);
    const ports = f.build();
    for (const text of ['保温杯', '感冒该吃什么药', '帮我找电子烟', '钱包在哪']) {
      expect(
        await ports.inputCheck.check({ ...input(), text }, new AbortController().signal),
      ).toEqual(unavailable);
    }
    expect(await ports.review.review('合成说明。')).toBe('timeout');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.unexpectedFetch).not.toHaveBeenCalled();
  },
);

it('[AC-B3-03m#7] 原调用方不传新端口时仍可构建，缺省拒绝', async () => {
  const f = fixture();
  const ports = createStreamReview({
    clock: f.time.clock,
    scheduler: f.time.scheduler,
    logger: f.logs.logger,
    texts: f.texts,
  });
  expect(await ports.inputCheck.check(input(), new AbortController().signal)).toEqual(unavailable);
  expect(await ports.review.review('合成说明。')).toBe('timeout');
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['staging', 'prod'] as const)(
  '[AC-B3-03m#8] %s 输入和输出使用不同审核 Service 且真实签名',
  async (appEnv) => {
    const f = fixture(['none'], { appEnv });
    const ports = f.build();
    expect(f.calls).toEqual([]);
    expect(await ports.inputCheck.check(input(), new AbortController().signal)).toMatchObject({
      kind: 'proceed',
      modelText: '合成保温杯',
    });
    expect(await ports.review.review('合成输出。')).toBe('pass');
    expect(f.calls.map(({ init }) => requestContent(init))).toEqual([
      { service: 'llm_query_moderation', content: '合成保温杯' },
      { service: 'llm_response_moderation', content: '合成输出。' },
    ]);
    for (const call of f.calls) {
      expect(call.url).toBe(endpoint);
      expect(call.init).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = Object.fromEntries(
        Object.entries(call.init.headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      expect(headers['authorization']).toMatch(
        /^ACS3-HMAC-SHA256 Credential=synthetic-review-id,SignedHeaders=[a-z0-9;-]+,Signature=[a-f0-9]{64}$/u,
      );
      expect(headers['x-acs-action']).toBe('TextModerationPlus');
    }
    expect(f.logs.lines.join('\n')).not.toContain(credentials.accessKeySecret);
    expect(f.unexpectedFetch).not.toHaveBeenCalled();
  },
);

it.each(['high', 'medium', 'low', 'http', 'code', 'json', 'throw', 'unknown'] satisfies Answer[])(
  '[AC-B3-03m#9][BR-AI-18] 输入 %s 在模型与工具之前拒绝',
  async (answer) => {
    const f = fixture([answer]);
    const ports = f.build();
    const r = setup();
    const blocked = ['high', 'medium', 'low'].includes(answer);
    expect(await r.run(ports)).toEqual({
      kind: 'done',
      finishReason: 'safety',
      ...(blocked ? {} : { ending: 'input_review_timeout' }),
    });
    expect(r.text()).toBe(`固定文案:agent.refuse.${blocked ? 'unsafe' : 'safety_unavailable'}`);
    expect(r.complete).not.toHaveBeenCalled();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.degraded).not.toHaveBeenCalled();
    expect(r.events.filter((event) => event.kind === 'card')).toEqual([]);
    expect(f.calls).toHaveLength(1);
  },
);

it.each([undefined, 250])(
  '[AC-B3-03m#10] 输入审核预算 %s 到期 fail-close，不等待迟到响应',
  async (timeoutMs) => {
    const f = fixture(['hang'], timeoutMs === undefined ? {} : { timeoutMs });
    const ports = f.build();
    let result: unknown;
    const pending = ports.inputCheck.check(input(), new AbortController().signal).then((value) => {
      result = value;
    });
    await flush();
    const budget = timeoutMs ?? 1000;
    await f.time.to(budget - 1);
    expect(result).toBeUndefined();
    await f.time.to(budget);
    await pending;
    expect(result).toEqual(unavailable);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
  },
);

it.each([
  ['感冒该吃什么药', 'agent.refuse.advice'],
  ['帮我找电子烟', 'agent.refuse.prohibited'],
])('[AC-B3-03m#11] 审核通过后仍复用真实输入关键词检查：%s', async (text, key) => {
  const f = fixture();
  const result = await f
    .build()
    .inputCheck.check({ ...input(), text }, new AbortController().signal);
  expect(result).toEqual({ kind: 'refuse', textKey: key, finishReason: 'safety' });
  expect(f.calls).toHaveLength(1);
});

it('[AC-B3-03m#12] 输出按句审核，通过前不下发，命中后结束', async () => {
  const f = fixture(['none', 'high']);
  const guard = createOutputGuard({ review: f.build().review });
  expect(await guard.push('合成第一')).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(await guard.push('句。')).toEqual([{ kind: 'text', text: '合成第一句。' }]);
  expect(await guard.push('合成第二句。')).toEqual([
    { kind: 'fixed', key: 'agent.refuse.output_blocked' },
  ]);
  expect(await guard.push('不应下发。')).toEqual([]);
  expect(await guard.end()).toEqual([]);
  expect(guard.stopped).toBe(true);
  expect(f.calls.map(({ init }) => requestContent(init))).toEqual([
    { service: 'llm_response_moderation', content: '合成第一句。' },
    { service: 'llm_response_moderation', content: '合成第二句。' },
  ]);
});

it.each(['none', 'hang'] as const)(
  '[AC-B3-03m#13] 输出首审超时整段缓冲，结束复审 %s',
  async (second) => {
    const f = fixture(['hang', second]);
    const guard = createOutputGuard({ review: f.build().review });
    const pushing = guard.push('合成第一句。');
    await flush();
    await f.time.to(1000);
    expect(await pushing).toEqual([]);
    expect(await guard.push('合成第二句。')).toEqual([]);
    expect(f.calls).toHaveLength(1);
    const ending = guard.end();
    await flush();
    expect(f.calls.map(({ init }) => requestContent(init).content)).toEqual([
      '合成第一句。',
      '合成第一句。合成第二句。',
    ]);
    if (second === 'hang') await f.time.to(2000);
    expect(await ending).toEqual(
      second === 'none'
        ? [{ kind: 'text', text: '合成第一句。合成第二句。' }]
        : [{ kind: 'fixed', key: 'agent.refuse.safety_timeout' }],
    );
    expect(f.calls).toHaveLength(2);
  },
);

it.each(['high', 'http'] as const)(
  '[AC-B3-03m#14] 输出 %s 保留已发卡片，拦截后不再执行后续工具',
  async (answer) => {
    const f = fixture(['none', answer]);
    const ports = f.build();
    const card = notice('已下发合成卡片');
    const r = setup(
      [
        { calls: [toolCall('first')], views: [{}] },
        { parts: ['合成模型说明。'], calls: [toolCall('second')], views: [{}] },
        { parts: ['结束。'] },
      ],
      {
        outcomes: [
          { kind: 'ok', modelView: {}, cards: [card] },
          { kind: 'ok', modelView: {}, cards: [notice('后发合成卡片')] },
        ],
      },
    );
    const result = await r.run(ports);
    if (answer === 'high') {
      expect(result).toEqual({ kind: 'done', finishReason: 'safety' });
      expect(r.execute).toHaveBeenCalledTimes(1);
      expect(r.events.filter((event) => event.kind === 'card')).toEqual([{ kind: 'card', card }]);
      expect(r.text()).toBe('固定文案:agent.refuse.output_blocked');
    } else {
      expect(r.execute).toHaveBeenCalledTimes(2);
      expect(r.events.filter((event) => event.kind === 'card')).toHaveLength(2);
      expect(r.text()).toContain('固定文案:agent.refuse.safety_timeout');
    }
    expect(r.text()).not.toContain('合成模型说明');
    expect(
      f.calls.filter(({ init }) => requestContent(init).service === 'llm_response_moderation')
        .length,
    ).toBeGreaterThan(0);
  },
);

it('[AC-B3-03m#15] 非生产工厂即使携带凭据也不调用注入 fetch', async () => {
  const f = fixture(['none'], { appEnv: 'test' });
  const options = { ...f.options };
  const read = vi.fn(() => credentials);
  Object.defineProperty(options, 'credentials', { get: read });
  const ports = createStreamReview({
    options,
    clock: f.time.clock,
    scheduler: f.time.scheduler,
    logger: f.logs.logger,
    texts: f.texts,
  });
  expect(await ports.inputCheck.check(input(), new AbortController().signal)).toEqual(unavailable);
  expect(read).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});
