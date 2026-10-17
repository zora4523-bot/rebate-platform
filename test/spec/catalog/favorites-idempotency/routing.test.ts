// B1-28e §B.1: all three writes use the platform transaction API, including replay.
import { expect, it, vi } from 'vitest';
import type { FavoritesService } from '../../../../apps/api/src/modules/catalog/favorites/types.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { controller, replySink, request, type Operation } from './kit.ts';

async function replay(operation: Operation) {
  const response = {
    status: 200,
    body: '{"code":0,"msg":"","data":{},"trace_id":"stored-trace"}',
    source: 'replay' as const,
  };
  // Neither mode calls the handler on a replay. Calling the wrong mode must fail an assertion,
  // not a fixture exception; no dependency on the implementer's new service method names.
  const idempotency = {
    execute: vi.fn<Idempotency['execute']>(async () => response),
    executeInTransaction: vi.fn<Idempotency['executeInTransaction']>(async () => response),
    abandon: vi.fn<Idempotency['abandon']>(),
    purgeExpired: vi.fn<Idempotency['purgeExpired']>(),
  };
  const favorites: FavoritesService = {
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
    removeFavorites: vi.fn(),
    listFavorites: vi.fn(),
    isFavorited: vi.fn(),
    deleteAllFavoritesOfUser: vi.fn(),
  };
  const reply = replySink();
  await controller(favorites, idempotency)[operation](request('fav-transaction-routing'), reply);
  return { reply, idempotency, favorites };
}

it('[AC-B1-28e#1] 加入收藏使用 executeInTransaction 并原样返回已保存响应', async () => {
  const f = await replay('add');
  expect(f.idempotency.executeInTransaction).toHaveBeenCalledTimes(1);
  expect(f.idempotency.execute).not.toHaveBeenCalled();
  expect(f.idempotency.executeInTransaction.mock.calls[0]?.[0]).toEqual({
    appId: 'fav-transaction-routing',
    actor: {
      userId: '01920000-0000-7000-8000-000000000028',
      deviceId: '01920000-0000-7000-8000-00000000d028',
      phoneHmac: null,
    },
    method: 'PUT',
    path: '/v1/me/favorites/taobao/tb%3Afavorite001',
    key: 'favorite-write-0001',
    body: undefined,
    traceId: 'original-trace',
  });
  expect(f.reply).toMatchObject({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: '{"code":0,"msg":"","data":{},"trace_id":"stored-trace"}',
  });
  expect(f.favorites.addFavorite).not.toHaveBeenCalled();
});

it('[AC-B1-28e#2] 取消收藏使用 executeInTransaction，重放不再调用删除用例', async () => {
  const f = await replay('remove');
  expect(f.idempotency.executeInTransaction).toHaveBeenCalledTimes(1);
  expect(f.idempotency.execute).not.toHaveBeenCalled();
  expect(f.idempotency.executeInTransaction.mock.calls[0]?.[0]).toMatchObject({
    appId: 'fav-transaction-routing',
    method: 'DELETE',
    path: '/v1/me/favorites/taobao/tb%3Afavorite001',
    key: 'favorite-write-0001',
    body: undefined,
  });
  expect(f.reply.body).toBe('{"code":0,"msg":"","data":{},"trace_id":"stored-trace"}');
  expect(f.favorites.removeFavorite).not.toHaveBeenCalled();
});

it('[AC-B1-28e#3] 批量删除使用 executeInTransaction 并保留请求体用于幂等比对', async () => {
  const f = await replay('batchDelete');
  expect(f.idempotency.executeInTransaction).toHaveBeenCalledTimes(1);
  expect(f.idempotency.execute).not.toHaveBeenCalled();
  expect(f.idempotency.executeInTransaction.mock.calls[0]?.[0]).toMatchObject({
    method: 'POST',
    path: '/v1/me/favorites/batch-delete',
    body: {
      items: [
        { platform: 'taobao', product_key: 'tb:favorite001' },
        { platform: 'taobao', product_key: 'tb:favorite002' },
      ],
    },
  });
  expect(f.reply.body).toBe('{"code":0,"msg":"","data":{},"trace_id":"stored-trace"}');
  expect(f.favorites.removeFavorites).not.toHaveBeenCalled();
});
