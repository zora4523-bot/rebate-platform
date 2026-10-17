// B1-28e: exercise the real controller after authentication, without a listening server.
// HTTP validation/authentication remain covered by the unchanged B1-28c route tests.
import type { FavoritesService } from '../../../../apps/api/src/modules/catalog/favorites/types.ts';
import { FavoritesController } from '../../../../apps/api/src/modules/catalog/http/public/favorites.controller.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';

export type Operation = 'add' | 'remove' | 'batchDelete';
export const userId = '01920000-0000-7000-8000-000000000028';
export const initialTime = '2031-05-20T04:00:00.000Z';
export const laterTime = '2031-05-20T04:02:00.000Z';

export function controller(favorites: FavoritesService, idempotency: Idempotency) {
  return new FavoritesController(
    {
      favorites,
      catalog: {
        listPlatforms: async () => [
          {
            code: 'taobao',
            key_prefix: 'tb',
            key_stability: 'stable_7d',
            search_support: 'supported',
            convert_support: 'supported',
            order_sync_support: 'supported',
            stage: 'm_beta',
          },
        ],
      },
    },
    idempotency,
  );
}

export function request(appId: string, key = 'favorite-write-0001', trace = 'original-trace') {
  return {
    id: trace,
    headers: { 'idempotency-key': key, 'x-channel': 'appstore' },
    // This is the verified server context, not a client identity header.
    principal: {
      uid: userId,
      app_id: appId,
      sid: 'synthetic-session',
      device_id: '01920000-0000-7000-8000-00000000d028',
      scp: 'full' as const,
    },
    params: { platform: 'taobao', product_key: 'tb:favorite001' },
    body: {
      items: [
        { platform: 'taobao', product_key: 'tb:favorite001' },
        { platform: 'taobao', product_key: 'tb:favorite002' },
      ],
    },
  };
}

export function replySink() {
  return {
    status: 0,
    contentType: '',
    body: '',
    code(value: number) {
      this.status = value;
      return this;
    },
    type(value: string) {
      this.contentType = value;
      return this;
    },
    send(value: string) {
      this.body = value;
    },
  };
}

export async function outcome(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'returned';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
