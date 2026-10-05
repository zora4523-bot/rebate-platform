import { expect, it } from 'vitest';
import {
  RedisValidationError,
  type RedisScriptOptions,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { failure, fixture } from './kit.ts';

const INVALID_TTLS: readonly unknown[] = [
  undefined,
  null,
  0,
  -1,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  '60',
  true,
];

it.each(INVALID_TTLS)('[AC-B1-01y-TTL#1] SET 拒绝无效 TTL %s，未发送命令', async (ttl) => {
  const { handle, driver } = await fixture();
  try {
    const cache = handle.namespace('catalog');
    const before = driver.call.mock.calls.length;
    expect(await failure(() => cache.set('item', 'v', ttl as number))).toBeInstanceOf(
      RedisValidationError,
    );
    expect(driver.call.mock.calls.length).toBe(before);
  } finally {
    await handle.close();
  }
});

it.each(INVALID_TTLS)('[AC-B1-01y-TTL#2] Lua 拒绝无效 TTL %s，未执行脚本', async (ttl) => {
  const { handle, driver } = await fixture();
  try {
    const before = driver.call.mock.calls.length;
    expect(
      await failure(() =>
        handle.namespace('risk').eval('return 1', {
          keys: ['nonce'],
          args: [],
          ttlSeconds: ttl as number,
        }),
      ),
    ).toBeInstanceOf(RedisValidationError);
    expect(driver.call.mock.calls.length).toBe(before);
  } finally {
    await handle.close();
  }
});

it('[AC-B1-01y-TTL#3] Lua 整个选项缺失也明确拒绝，不产生 TypeError 或命令', async () => {
  const { handle, driver } = await fixture();
  try {
    const before = driver.call.mock.calls.length;
    expect(
      await failure(() =>
        handle.namespace('risk').eval('return 1', undefined as unknown as RedisScriptOptions),
      ),
    ).toBeInstanceOf(RedisValidationError);
    expect(driver.call.mock.calls.length).toBe(before);
  } finally {
    await handle.close();
  }
});

it.each(['', 'Risk', 'risk:other', 'a.b', 'a/b', '*', 'a b', '中文', 'a\n', 'a\0'])(
  '[AC-B1-01y-NS#1] 拒绝非法命名空间 %j',
  async (namespace) => {
    const { handle, driver } = await fixture();
    try {
      const before = driver.call.mock.calls.length;
      expect(await failure(() => handle.namespace(namespace))).toBeInstanceOf(RedisValidationError);
      expect(driver.call.mock.calls.length).toBe(before);
    } finally {
      await handle.close();
    }
  },
);

it.each(['catalog', 'risk_2', 'session-cache', 'a0'])(
  '[AC-B1-01y-NS#2] %s 的读取和写入始终有前缀，SET 与秒 TTL 原子提交',
  async (namespace) => {
    const { handle, driver } = await fixture();
    try {
      const cache = handle.namespace(namespace);
      driver.call.mockClear();
      await cache.set('item:42', '值', 17);
      expect(driver.call.mock.calls).toEqual([['SET', `${namespace}:item:42`, '值', 'EX', 17]]);
      driver.call.mockResolvedValueOnce('值').mockResolvedValueOnce(null);
      expect(await cache.get('item:42')).toBe('值');
      expect(await cache.get('missing')).toBeNull();
      expect(driver.call.mock.calls.slice(1)).toEqual([
        ['GET', `${namespace}:item:42`],
        ['GET', `${namespace}:missing`],
      ]);
    } finally {
      await handle.close();
    }
  },
);

it('[AC-B1-01y-LUA#1] Lua 所有 KEYS 加前缀，ARGV[1] 为 TTL，其余参数和结果不变', async () => {
  const { handle, driver } = await fixture();
  try {
    const script = 'return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}';
    const options = Object.freeze({
      keys: Object.freeze(['one', 'two']),
      args: Object.freeze(['payload']),
      ttlSeconds: 9,
    });
    driver.call.mockClear();
    driver.call.mockResolvedValueOnce(['risk:one', 'risk:two', '9', 'payload']);
    expect(await handle.namespace('risk').eval(script, options)).toEqual([
      'risk:one',
      'risk:two',
      '9',
      'payload',
    ]);
    expect(driver.call.mock.calls).toEqual([
      ['EVAL', script, 2, 'risk:one', 'risk:two', 9, 'payload'],
    ]);
    expect(options.keys).toEqual(['one', 'two']);
  } finally {
    await handle.close();
  }
});
