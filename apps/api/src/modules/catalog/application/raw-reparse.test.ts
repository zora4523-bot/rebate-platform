import { expect, it, vi } from 'vitest';
import { FixedClock, type RedisNamespace } from '../../platform/index.ts';
import type { UnionAdapter } from '../../union/index.ts';
import { createRawReparser, type RawReparseTarget } from './raw-reparse.ts';

const NOW = '2026-11-01T02:00:00.000Z';
const OTHER_OWNER = 'synthetic-owner';

const target: RawReparseTarget = {
  appId: 'app',
  platform: 'taobao',
  productKey: 'tb:K1',
  jdMode: 'item',
  canonicalUrl: null,
  title: 'K1',
  source: 'detail',
  isTarget: () => true,
};

function reparserOver(redis: RedisNamespace, searchItems: UnionAdapter['searchItems']) {
  const adapter = { searchItems } as unknown as UnionAdapter;
  return createRawReparser({
    union: { adapter: () => adapter },
    clock: new FixedClock(NOW),
    redis,
  });
}

it('[BR-PROD-05] 等锁的一方读持锁方留下的结果，不问联盟', async () => {
  const searchItems = vi.fn<UnionAdapter['searchItems']>();
  const redis: RedisNamespace = {
    eval: async () => OTHER_OWNER,
    get: async (key) =>
      key === `result:${OTHER_OWNER}` ? JSON.stringify({ kind: 'off_shelf' }) : null,
    set: async () => undefined,
  };

  await expect(reparserOver(redis, searchItems).reparse(target)).resolves.toEqual({
    kind: 'off_shelf',
  });
  expect(searchItems).not.toHaveBeenCalled();
});

it('[BR-PROD-05] 持锁方抛出未分类的错误：等的一方读到暂时失败，错误照常抛出，锁放开', async () => {
  const written = new Map<string, string>();
  const scripts: string[] = [];
  const redis: RedisNamespace = {
    eval: async (script, options) => {
      scripts.push(script);
      return options.args[0];
    },
    get: async () => null,
    set: async (key, value) => {
      written.set(key, value);
    },
  };
  const bug = new Error('synthetic bug');

  await expect(reparserOver(redis, () => Promise.reject(bug)).reparse(target)).rejects.toBe(bug);

  expect([...written.values()]).toEqual([JSON.stringify({ kind: 'temporary_failure' })]);
  expect(scripts).toHaveLength(2);
});
