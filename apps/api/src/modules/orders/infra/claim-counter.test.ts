// B1-10b 源码旁单元测试：失败计数的键、TTL 与读值校验，以及同一请求（幂等键 + 请求体）只计一次。
// 不连 Redis：假实现按计数脚本的约定（有标记不加、回 0；否则加 1 并写标记）模拟一次 eval。
import { expect, it } from 'vitest';
import type { RedisHandle, RedisNamespace, RedisScriptOptions } from '../../platform/index.ts';
import {
  ClaimCounterError,
  claimRequestId,
  claimRequestMarkKey,
  createClaimFailureCounter,
} from './claim-counter.ts';

const subject = { app_id: 'claims_unit', user_id: '019c0000-0000-7000-8000-000000000001' };
const body = { platform: 'jd', order_no: 'unit-missing', paid_date: '2028-01-15' };

function fakeRedis(values: Map<string, string>) {
  const calls: { name: string; op: string; keys: readonly string[]; ttl?: number }[] = [];
  const handle: RedisHandle = {
    namespace(name): RedisNamespace {
      return {
        get: async (key) => {
          calls.push({ name, op: 'get', keys: [key] });
          return values.get(`${name}:${key}`) ?? null;
        },
        set: async () => {
          throw new Error('set is not used');
        },
        eval: async (_script: string, options: RedisScriptOptions) => {
          calls.push({ name, op: 'eval', keys: [...options.keys], ttl: options.ttlSeconds });
          const [counter, mark] = options.keys.map((key) => `${name}:${key}`);
          if (mark !== undefined && values.has(mark)) return 0;
          const next = Number(values.get(counter!) ?? '0') + 1;
          values.set(counter!, String(next));
          if (mark !== undefined) values.set(mark, '1');
          return next;
        },
      };
    },
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { handle, calls };
}

it('[AC-B1-10b#27] 计数键为 claim:{app_id}:{user_id}:{yyyymmdd}，一次失败一次 eval 带 TTL', async () => {
  const values = new Map<string, string>();
  const { handle, calls } = fakeRedis(values);
  const counter = createClaimFailureCounter(handle, subject);
  expect(calls).toEqual([]);
  expect(await counter.read('20280115')).toBe(0);
  expect(await counter.increment('20280115', 2)).toBe(1);
  expect(await counter.read('20280115')).toBe(1);
  const key = `${subject.app_id}:${subject.user_id}:20280115`;
  expect(calls).toEqual([
    { name: 'claim', op: 'get', keys: [key] },
    { name: 'claim', op: 'eval', keys: [key], ttl: 2 },
    { name: 'claim', op: 'get', keys: [key] },
  ]);
});

it('[AC-B1-10b#28] 读到非计数值时拒绝（调用方失败关闭）', async () => {
  const values = new Map([[`claim:${subject.app_id}:${subject.user_id}:20280115`, 'x1']]);
  const counter = createClaimFailureCounter(fakeRedis(values).handle, subject);
  await expect(counter.read('20280115')).rejects.toBeInstanceOf(ClaimCounterError);
});

it('[AC-B1-10b#38] 同一请求标识只计一次：一次 eval 带计数键与标记键、同一 TTL；再加回 null 且计数不变', async () => {
  const values = new Map<string, string>([
    [`claim:${subject.app_id}:${subject.user_id}:20280115`, '8'],
  ]);
  const { handle, calls } = fakeRedis(values);
  const counter = createClaimFailureCounter(handle, subject);
  const request = claimRequestId('unit-key-0001', body);
  expect(await counter.increment('20280115', 30, request)).toBe(9);
  expect(await counter.increment('20280115', 30, request)).toBeNull();
  expect(await counter.read('20280115')).toBe(9);
  const key = `${subject.app_id}:${subject.user_id}:20280115`;
  const mark = claimRequestMarkKey(subject, '20280115', request);
  expect(mark).toBe(`${key}:req:${request}`);
  expect(calls.filter((call) => call.op === 'eval')).toEqual([
    { name: 'claim', op: 'eval', keys: [key, mark], ttl: 30 },
    { name: 'claim', op: 'eval', keys: [key, mark], ttl: 30 },
  ]);
  // Another request of the same day, and the same request on another day, count again.
  expect(await counter.increment('20280115', 30, claimRequestId('unit-key-0002', body))).toBe(10);
  expect(await counter.increment('20280116', 30, request)).toBe(1);
});

it('[AC-B1-10b#38] 请求标识由幂等键与规范化请求体决定（键序无关）', () => {
  const id = claimRequestId('unit-key-0001', body);
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  expect(claimRequestId('unit-key-0001', { ...body })).toBe(id);
  expect(
    claimRequestId('unit-key-0001', {
      paid_date: body.paid_date,
      order_no: body.order_no,
      platform: body.platform,
    }),
  ).toBe(id);
  expect(claimRequestId('unit-key-0002', body)).not.toBe(id);
  expect(claimRequestId('unit-key-0001', { ...body, order_no: 'unit-other' })).not.toBe(id);
});

it('[AC-B1-10b#28] 无请求标识时脚本回 0、或请求标识格式不对，都拒绝（调用方失败关闭）', async () => {
  const zero: RedisHandle = {
    namespace: () => ({
      get: async () => null,
      set: async () => undefined,
      eval: async () => 0,
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  const counter = createClaimFailureCounter(zero, subject);
  await expect(counter.increment('20280115', 30)).rejects.toBeInstanceOf(ClaimCounterError);
  expect(await counter.increment('20280115', 30, claimRequestId('unit-key-0001', body))).toBeNull();
  const values = new Map<string, string>();
  const { handle, calls } = fakeRedis(values);
  await expect(
    createClaimFailureCounter(handle, subject).increment('20280115', 30, 'not-a-request-id'),
  ).rejects.toBeInstanceOf(ClaimCounterError);
  expect(calls).toEqual([]);
});
