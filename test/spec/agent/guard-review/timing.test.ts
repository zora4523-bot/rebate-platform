import { expect, it, vi } from 'vitest';
import type { AliyunReviewFetchResponse } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import {
  CONTENT,
  SIDES,
  SIGNED_HEADERS,
  fixture,
  flush,
  observe,
  response,
  verdictBody,
} from './kit.ts';

for (const side of SIDES) {
  it(`[AC-B3-06b#7][BR-AI-18] ${side} 默认 1000ms 到点返回 timeout 并中止无响应请求`, async () => {
    // 故意不响应 abort：适配器必须自行结束等待，不能依赖 fetch 配合。
    const late = Promise.withResolvers<AliyunReviewFetchResponse>();
    const f = fixture(side, { fetch: () => late.promise });
    const result = observe(f.port.review(CONTENT));
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.init.signal.aborted).toBe(false);
    await f.scheduler.advance(999);
    expect(result.settled).toBe('pending');
    await f.scheduler.advance(1);
    expect(result).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    late.resolve(response(verdictBody('none')));
    await flush();
    expect(result.value).toBe('timeout');
    expect(f.calls).toHaveLength(1);
    expect(f.scheduler.pending).toBe(0);
  });

  it.each(['none', 'high'] as const)(
    `[AC-B3-06b#8][BR-AI-18] ${side} 时限内返回 %s 使用审核结果并释放计时器`,
    async (risk) => {
      const pending = Promise.withResolvers<AliyunReviewFetchResponse>();
      const f = fixture(side, { fetch: () => pending.promise });
      const result = observe(f.port.review(CONTENT));
      await f.scheduler.advance(999);
      expect(result.settled).toBe('pending');
      pending.resolve(response(verdictBody(risk)));
      await flush();
      expect(result).toMatchObject({
        settled: 'resolved',
        value: risk === 'none' ? 'pass' : 'block',
      });
      expect(f.scheduler.pending).toBe(0);
      await f.scheduler.advance(1);
      expect(result.value).toBe(risk === 'none' ? 'pass' : 'block');
    },
  );

  it(`[AC-B3-06b#9][BR-AI-18] ${side} 每次审核读取当前配置，独立计时与取消`, async () => {
    // 37/83 只是注入配置的测试样本，不是新的业务默认值或上下限。
    let budget = 37;
    const timeoutMs = vi.fn(() => budget);
    const f = fixture(side, { timeoutMs, fetch: () => new Promise(() => {}) });
    const first = observe(f.port.review('合成请求甲'));
    await flush();
    budget = 83;
    const second = observe(f.port.review('合成请求乙'));
    await flush();
    expect(timeoutMs).toHaveBeenCalledTimes(2);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.init.signal).not.toBe(f.calls[1]?.init.signal);
    await f.scheduler.advance(36);
    expect(first.settled).toBe('pending');
    expect(second.settled).toBe('pending');
    await f.scheduler.advance(1);
    expect(first).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(second.settled).toBe('pending');
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    expect(f.calls[1]?.init.signal.aborted).toBe(false);
    await f.scheduler.advance(45);
    expect(second.settled).toBe('pending');
    await f.scheduler.advance(1);
    expect(second).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(f.calls[1]?.init.signal.aborted).toBe(true);
    expect(timeoutMs).toHaveBeenCalledTimes(2);
  });

  it(`[AC-B3-06b#10][BR-AI-18] ${side} 收到响应头不重置时限，读取正文也受原时限约束`, async () => {
    const headers = Promise.withResolvers<AliyunReviewFetchResponse>();
    const body = Promise.withResolvers<string>();
    const f = fixture(side, { fetch: () => headers.promise });
    const result = observe(f.port.review(CONTENT));
    await f.scheduler.advance(600);
    headers.resolve({ status: 200, text: () => body.promise });
    await f.scheduler.advance(399);
    expect(result.settled).toBe('pending');
    await f.scheduler.advance(1);
    expect(result).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
    body.resolve(JSON.stringify(verdictBody('none')));
    await flush();
    expect(result.value).toBe('timeout');
  });

  it(`[AC-B3-06b#11][BR-AI-18] ${side} 签名挂起也按审核时限结束，迟到签名不得发送请求`, async () => {
    const pending = Promise.withResolvers<Readonly<Record<string, string>>>();
    let signSignal: AbortSignal | undefined;
    const f = fixture(side, {
      sign: (_request, _credentials, signal) => {
        signSignal = signal;
        return pending.promise;
      },
    });
    const result = observe(f.port.review(CONTENT));
    await f.scheduler.advance(999);
    expect(result.settled).toBe('pending');
    expect(f.calls).toHaveLength(0);
    await f.scheduler.advance(1);
    expect(result).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(signSignal?.aborted).toBe(true);
    pending.resolve(SIGNED_HEADERS);
    await flush();
    expect(f.calls).toHaveLength(0);
  });

  it(`[AC-B3-06b#12][BR-AI-18] ${side} 签名耗时计入总预算，发出请求后不重新计时`, async () => {
    const pending = Promise.withResolvers<Readonly<Record<string, string>>>();
    const f = fixture(side, {
      sign: () => pending.promise,
      fetch: () => new Promise(() => {}),
    });
    const result = observe(f.port.review(CONTENT));
    await f.scheduler.advance(600);
    pending.resolve(SIGNED_HEADERS);
    await flush();
    expect(f.calls).toHaveLength(1);
    await f.scheduler.advance(399);
    expect(result.settled).toBe('pending');
    await f.scheduler.advance(1);
    expect(result).toMatchObject({ settled: 'resolved', value: 'timeout' });
    expect(f.calls[0]?.init.signal.aborted).toBe(true);
  });
}
