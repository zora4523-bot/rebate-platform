import { expect, it } from 'vitest';
import { createOutputGuard } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { fixture, flush, observe, requestContent } from './kit.ts';

// 只验证适配器与 B3-06a 的端口衔接；不重测过滤、卡片或输入配额处置。
it('[AC-B3-06b#17][BR-AI-18] 输出审核超时后整段复审，再超时仅返回固定话术', async () => {
  const f = fixture('output', { fetch: () => new Promise(() => {}) });
  const guard = createOutputGuard({ review: f.port });
  const pushing = observe(guard.push('合成第一句。'));
  await flush();
  expect(pushing.settled).toBe('pending');
  await f.scheduler.advance(1000);
  expect(pushing).toMatchObject({ settled: 'resolved', value: [] });
  expect(await guard.push('合成第二句。')).toEqual([]);
  expect(f.calls).toHaveLength(1);
  const ending = observe(guard.end());
  await flush();
  expect(f.calls.map((call) => requestContent(call.init))).toEqual([
    { content: '合成第一句。' },
    { content: '合成第一句。合成第二句。' },
  ]);
  await f.scheduler.advance(1000);
  expect(ending).toMatchObject({
    settled: 'resolved',
    value: [{ kind: 'fixed', key: 'agent.refuse.safety_timeout' }],
  });
  expect(guard.summary().safety).toBe('timeout_replaced');
  expect(guard.stopped).toBe(false);
  expect(f.calls).toHaveLength(2);
  expect(f.calls.every((call) => call.init.signal.aborted)).toBe(true);
});
