// B1-01zt 台账②：深度上限由实现决定；只约束远超上限与正常深度。
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  canonicalJson,
  createIdempotency,
  requestHashOf,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  outcome,
  outcomeSync,
  poisonDb,
  recordingLogger,
  request,
  result,
  sha256Hex,
} from './kit.ts';

// 从文本解析构造深树，夹具本身不递归或 stringify 深树。
function nested(depth: number, array: boolean): { body: unknown; text: string } {
  const text = array
    ? '['.repeat(depth) + '0' + ']'.repeat(depth)
    : '{"child":'.repeat(depth) + '0' + '}'.repeat(depth);
  return { body: JSON.parse(text) as unknown, text };
}

it.each([false, true])(
  '[AC-B1-01zt#2] 数组=%s：10000 层归一化及哈希返回 invalid_request，50 层保持原哈希',
  (array) => {
    const normal = nested(50, array);
    expect(canonicalJson(normal.body)).toBe(normal.text);
    expect(requestHashOf(normal.body)).toBe(sha256Hex(normal.text));
    const deep = nested(10_000, array);
    expect.soft(outcomeSync(() => canonicalJson(deep.body))).toEqual({
      error: 'IdempotencyError invalid_request',
    });
    expect.soft(outcomeSync(() => requestHashOf(deep.body))).toEqual({
      error: 'IdempotencyError invalid_request',
    });
    // 同进程后续调用仍正常，不留下递归访问状态。
    expect(canonicalJson(normal.body)).toBe(normal.text);
  },
  30_000,
);

it.each(['execute', 'executeInTransaction'] as const)(
  '[AC-B1-01zt#2] %s 在触库和处理函数之前拒绝超深请求，错误类型不是 RangeError',
  async (mode) => {
    const { logger, calls } = recordingLogger();
    const idem = createIdempotency({
      db: poisonDb(),
      clock: new FixedClock('2031-05-06T07:08:09.123Z'),
      logger,
    });
    const handler = vi.fn(async () => result(0, 200));
    expect(
      await outcome(() => idem[mode](request({ body: nested(10_000, false).body }), handler)),
    ).toEqual({ error: 'IdempotencyError invalid_request' });
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  },
  30_000,
);
