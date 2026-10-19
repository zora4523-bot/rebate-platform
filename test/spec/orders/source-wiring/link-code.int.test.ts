import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createLinkRegistration } from '../../../../apps/api/src/modules/linking/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { order } from '../attribution/kit.ts';
import { job } from '../sync/kit.ts';
import { account, pid, START, user } from '../wiring/db-kit.ts';
import { built, codeDb, databaseFixture, registration, row } from '../../linking/link-code/kit.ts';
import { config } from './db-kit.ts';
import { wired } from './kit.ts';

const database = databaseFixture(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B1-08s#27] 真实登记生成 lk → worker 接收同码订单 → source_match exact，不依赖商品匹配', async () => {
  const db = database();
  const coded = await codeDb(db);
  const acc = await account(db);
  const u = await user(db, acc.app_id);
  await pid(db, acc);
  await config(db, acc.app_id, 'attr.click_code.pdd', true);
  const register = registration(db, 'pdd');
  const options = {
    ...register.options,
    clock: new FixedClock('2026-10-14T12:13:14.000Z'),
    context: { scene: 'search' },
    callerContext: { current: async () => ({ appId: acc.app_id, userId: u.id, deviceId: null }) },
    attrCodes: { attrCode: async () => u.attr_code },
  };
  const link = await built(() =>
    createLinkRegistration(options).register({
      ...register.request,
      ref: { ...register.request.ref, appId: acc.app_id, productKey: `pdd:${randomUUID()}` },
    }),
  );
  const saved = await row(coded, link.linkId);
  expect(saved.lk).toBe('a1b2c3');
  const incoming = order({
    raw_status: '0',
    sub_order_id: randomUUID(),
    goods_id: randomUUID(),
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: JSON.stringify({ app: 'n', uid: u.attr_code, sc: 'share', lk: saved.lk }),
    },
  });
  const f = await built(() => wired(db));
  try {
    expect(typeof f.sources.linkByCode).toBe('function');
    const listOrders = vi
      .fn<UnionAdapter['listOrders']>()
      .mockResolvedValue({ items: [incoming], nextCursor: null });
    vi.spyOn(f.r.access, 'queryableAccount').mockResolvedValue(acc.id);
    vi.spyOn(f.r.registry, 'get').mockReturnValue({ listOrders });
    const run = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
    expect(typeof run).toBe('function');
    await built(() =>
      run!(
        job({
          app_id: acc.app_id,
          platform: 'pdd',
          union_account_id: acc.id,
          query_kind: 'increment',
          scene: '-',
          window_start: START,
          window_end: '2026-10-17T17:00:00.000Z',
        }),
      ),
    );
    expect(
      await db
        .selectFrom('orders')
        .select(['user_id', 'source_match', 'source_scene', 'link_id', 'agent_session_id'])
        .where('app_id', '=', acc.app_id)
        .execute(),
    ).toEqual([
      {
        user_id: u.id,
        source_match: 'exact',
        source_scene: 'search',
        link_id: link.linkId,
        agent_session_id: null,
      },
    ]);
  } finally {
    await f.context.close();
  }
});
