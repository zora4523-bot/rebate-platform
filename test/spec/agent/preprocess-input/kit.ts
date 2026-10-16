import { expect, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RedactedText } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { InputCheckResult } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ReviewVerdict } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { createInputCheck } from '../../../../apps/api/src/modules/agent/preprocess/input/index.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';

export { flush, observe } from '../../platform/http/kit.ts';

export function input(text: string, stored = text): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-input-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      userId: 'synthetic-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text,
    // 测试输入品牌夹具；存储脱敏本身由 B3-05a 测试，本任务不另实现脱敏。
    redactedText: stored as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

export function setup(
  verdict: ReviewVerdict | Error | (() => Promise<ReviewVerdict>) = 'pass',
  timeoutMs?: number,
) {
  const scheduler = new ManualScheduler();
  const review = vi.fn(async (_text: string): Promise<ReviewVerdict> => {
    void _text;
    if (verdict instanceof Error) throw verdict;
    return typeof verdict === 'function' ? verdict() : verdict;
  });
  const text = vi.fn(async (appId: string, key: string) => `合成文案:${appId}:${key}`);
  // 每条行为测试首先进入工厂；骨架抛 NotImplemented，不捕获成伪成功。
  const port = createInputCheck({
    review: { review },
    scheduler,
    texts: { text },
    ...(timeoutMs === undefined ? {} : { timeoutMs: () => timeoutMs }),
  });
  const check = (message: string, stored?: string) =>
    port.check(input(message, stored), new AbortController().signal);
  return { port, check, scheduler, review, text };
}

export function proceed(result: InputCheckResult) {
  expect(result.kind).toBe('proceed');
  if (result.kind !== 'proceed') throw new Error('AssertionError: expected proceed');
  expect(result).not.toHaveProperty('textKey');
  expect(result).not.toHaveProperty('ending');
  return result;
}

export function refused(result: InputCheckResult, key: string, refund = false): void {
  expect(result).toEqual({
    kind: 'refuse',
    textKey: key,
    finishReason: 'safety',
    ...(refund ? { ending: 'input_review_timeout' } : {}),
  });
  // InputCheckPort 没有扣费字段；审核不可用必须交退还 ending，其余拒答正常计配额。
  for (const field of [
    'modelText',
    'placeholders',
    'links',
    'notices',
    'untrustedInput',
    'paramsRequested',
  ]) {
    expect(result).not.toHaveProperty(field);
  }
}
