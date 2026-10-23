import { vi } from 'vitest';
import type {
  AliyunReviewFetch,
  AliyunReviewFetchInit,
} from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import {
  createStreamReview,
  type StreamReviewOptions,
} from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { Logs } from '../stream-recovery/kit.ts';
import { ManualTime, flush } from '../stream-run/kit.ts';

export { flush };
export const credentials = {
  accessKeyId: 'synthetic-review-id',
  accessKeySecret: 'synthetic-review-secret',
};
export const endpoint = 'https://review.example.invalid/';
export type Answer =
  'none' | 'high' | 'medium' | 'low' | 'http' | 'code' | 'json' | 'throw' | 'hang' | 'unknown';

/** Synthetic responses use only the B3-06b documented Code/Data.RiskLevel fields. */
export function transport(answers: readonly Answer[] = ['none']) {
  // A wiring bug must never escape the synthetic transport to a real network.
  const unexpectedFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch: use the injected synthetic transport');
  });
  vi.stubGlobal('fetch', unexpectedFetch);
  const calls: { url: string; init: AliyunReviewFetchInit }[] = [];
  const fetch = vi.fn<AliyunReviewFetch>(async (url, init) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1] ?? answers.at(-1) ?? 'none';
    if (answer === 'throw') throw new Error('synthetic transport unavailable');
    if (answer === 'hang') return new Promise(() => {});
    return {
      status: answer === 'http' ? 503 : 200,
      text: async () =>
        answer === 'json'
          ? '{'
          : JSON.stringify({
              Code: answer === 'code' ? 500 : 200,
              Data: { RiskLevel: answer === 'unknown' ? 'new-risk' : answer },
            }),
    };
  });
  return { fetch, calls, unexpectedFetch };
}

export function requestContent(init: AliyunReviewFetchInit): {
  service: string | null;
  content: string;
} {
  const form = new URLSearchParams(init.body);
  const params = JSON.parse(form.get('ServiceParameters') ?? '{}') as { content: string };
  return { service: form.get('Service'), content: params.content };
}

export function fixture(
  answers: readonly Answer[] = ['none'],
  patch: Partial<StreamReviewOptions> = {},
) {
  const time = new ManualTime();
  const logs = new Logs();
  const wire = transport(answers);
  let nonce = 0;
  const options: StreamReviewOptions = {
    appEnv: 'staging',
    credentials,
    endpoint,
    fetch: wire.fetch,
    nonce: () => `synthetic-nonce-${++nonce}`,
    ...patch,
  };
  const texts = { text: async (_appId: string, key: string) => `固定文案:${key}` };
  return {
    ...wire,
    time,
    logs,
    options,
    texts,
    build: () =>
      createStreamReview({
        options,
        clock: time.clock,
        scheduler: time.scheduler,
        logger: logs.logger,
        texts,
      }),
  };
}
