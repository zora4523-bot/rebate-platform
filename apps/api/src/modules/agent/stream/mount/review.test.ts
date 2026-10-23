// B3-03n unit tests (implementer's own): the per-app agent.safety.timeout_ms read of the input
// review fails closed when the configuration read itself fails or hangs, and a missing key falls
// back to options.timeoutMs. Synthetic transport and scheduler only; no network, no database.
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../admission/index.ts';
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type { AliyunReviewFetch } from '../../guard/review/index.ts';
import { createStreamReview, type StreamReviewConfigReader } from './review.ts';

const UNAVAILABLE = {
  kind: 'refuse',
  textKey: 'agent.refuse.safety_unavailable',
  finishReason: 'safety',
  ending: 'input_review_timeout',
} as const;

function input(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成保温杯',
    redactedText: '合成保温杯' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

/** A scheduler whose sleeps settle only when `advance` passes their due time. */
function manualScheduler() {
  let now = 0;
  const timers: { due: number; resolve: () => void; signal?: AbortSignal }[] = [];
  const scheduler: Scheduler = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        const timer = { due: now + ms, resolve, ...(signal === undefined ? {} : { signal }) };
        timers.push(timer);
        signal?.addEventListener(
          'abort',
          () => {
            timers.splice(timers.indexOf(timer), 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  const advance = async (to: number) => {
    now = to;
    for (const timer of [...timers]) {
      if (timer.due <= now) {
        timers.splice(timers.indexOf(timer), 1);
        timer.resolve();
      }
    }
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };
  return { scheduler, advance };
}

function setup(configValue: StreamReviewConfigReader['configValue'], timeoutMs?: number) {
  const time = manualScheduler();
  const fetch = vi.fn<AliyunReviewFetch>(() => new Promise(() => undefined));
  const warn = vi.fn();
  const ports = createStreamReview({
    options: {
      appEnv: 'staging',
      credentials: { accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' },
      endpoint: 'https://synthetic-review.invalid/',
      fetch,
      nonce: () => 'synthetic-nonce',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    clock: { now: () => new Date('2026-10-23T00:00:00.000Z') } as Clock,
    scheduler: time.scheduler,
    logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as RootLogger,
    texts: { text: async (_appId, key) => `固定文案:${key}` },
    config: { configValue },
  });
  return { ports, fetch, warn, time };
}

function settled(check: Promise<unknown>) {
  const box: { value?: unknown } = {};
  void check.then((value) => {
    box.value = value;
  });
  return box;
}

it('[AC-B3-03n#u1][BR-AI-18] 读 agent.safety.timeout_ms 失败（如连接超时）按审核不可用 fail-close，不调审核、不抛内部错误', async () => {
  const s = setup(async () => {
    throw new Error('synthetic connection timeout');
  });
  const result = await s.ports.inputCheck.check(input(), new AbortController().signal);
  expect(result).toEqual(UNAVAILABLE);
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.warn).toHaveBeenCalledWith(
    { app_id: 'synthetic-app' },
    'agent_safety_timeout_unreadable',
  );
});

it('[AC-B3-03n#u2][BR-AI-18] 配置读取挂起：到默认 1000ms 按审核不可用 fail-close，之前不放行', async () => {
  const s = setup(() => new Promise(() => undefined));
  const box = settled(s.ports.inputCheck.check(input(), new AbortController().signal));
  await s.time.advance(999);
  expect(box.value).toBe(undefined);
  await s.time.advance(1000);
  expect(box.value).toEqual(UNAVAILABLE);
  expect(s.fetch).not.toHaveBeenCalled();
});

it('[AC-B3-03n#u3][BR-AI-18] 未配置 agent.safety.timeout_ms 时取组合根的 options.timeoutMs；已配置的合法值优先', async () => {
  const values: unknown[] = [null, { value: 600 }];
  const s = setup(async () => (values.shift() ?? null) as { value: unknown } | null, 250);
  const first = settled(s.ports.inputCheck.check(input(), new AbortController().signal));
  // The configuration read settles first; the review deadline then starts at this instant.
  await s.time.advance(0);
  await s.time.advance(249);
  expect(first.value).toBe(undefined);
  await s.time.advance(250);
  expect(first.value).toEqual(UNAVAILABLE);

  const second = settled(s.ports.inputCheck.check(input(), new AbortController().signal));
  await s.time.advance(250);
  await s.time.advance(849);
  expect(second.value).toBe(undefined);
  await s.time.advance(850);
  expect(second.value).toEqual(UNAVAILABLE);
});

it('[AC-B3-03n#u4][BR-AI-18] 运行已取消时不读配置结果、不记不可读告警，直接按审核不可用返回', async () => {
  const s = setup(async () => ({ value: 300 }));
  const controller = new AbortController();
  controller.abort('cancelled');
  expect(await s.ports.inputCheck.check(input(), controller.signal)).toEqual(UNAVAILABLE);
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.warn).not.toHaveBeenCalled();
});
