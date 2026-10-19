import { expect, it } from 'vitest';
import type { RedisHandle, RedisNamespace, RedisScriptOptions } from '../../platform/index.ts';
import { ClaimCounterError, createClaimFailureCounter } from './claim-counter.ts';

const subject = { app_id: 'claims_unit', user_id: '019c0000-0000-7000-8000-000000000001' };

function fakeRedis(values: Map<string, string>) {
  const calls: { name: string; op: string; key: string; ttl?: number }[] = [];
  const handle: RedisHandle = {
    namespace(name): RedisNamespace {
      return {
        get: async (key) => {
          calls.push({ name, op: 'get', key });
          return values.get(`${name}:${key}`) ?? null;
        },
        set: async () => {
          throw new Error('set is not used');
        },
        eval: async (_script: string, options: RedisScriptOptions) => {
          const key = options.keys[0]!;
          calls.push({ name, op: 'eval', key, ttl: options.ttlSeconds });
          const next = Number(values.get(`${name}:${key}`) ?? '0') + 1;
          values.set(`${name}:${key}`, String(next));
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
    { name: 'claim', op: 'get', key },
    { name: 'claim', op: 'eval', key, ttl: 2 },
    { name: 'claim', op: 'get', key },
  ]);
});

it('[AC-B1-10b#28] 读到非计数值时拒绝（调用方失败关闭）', async () => {
  const values = new Map([[`claim:${subject.app_id}:${subject.user_id}:20280115`, 'x1']]);
  const counter = createClaimFailureCounter(fakeRedis(values).handle, subject);
  await expect(counter.read('20280115')).rejects.toBeInstanceOf(ClaimCounterError);
});
