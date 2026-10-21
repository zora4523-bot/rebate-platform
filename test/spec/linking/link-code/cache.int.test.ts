import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { createTaobaoLinkOpen } from '../../../../apps/api/src/modules/linking/index.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { createRedisJumpCache } from '../../../../apps/api/src/modules/linking/infra/jump-cache.ts';
import { setup } from '../open-taobao/kit.ts';
import { built, codeDb, databaseFixture, row } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#24] %s 同用户同商品同 pid 两个 lk 分开缓存；未注入时不出现 linkCode 字段',
  async (platform) => {
    const db = await codeDb(database());
    const f = await built(() => setup(database(), 'detail', platform));
    await f.bind('active');
    f.f.config.set(`attr.click_code.${platform}`, true);
    const original = await row(db, f.row.link_id);
    const first = { ...original, link_id: randomUUID(), lk: 'cache1' };
    const second = { ...original, link_id: randomUUID(), lk: 'cache2' };
    await db.insertInto('links').values([first, second]).execute();
    const store = new Map<string, string>();
    const cache = createRedisJumpCache(
      {
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => {
          store.set(key, value);
        },
        eval: async () => null,
      },
      f.f.clock,
      { warn: vi.fn() },
    );
    const get = vi.spyOn(cache, 'get');
    const put = vi.spyOn(cache, 'put');
    const service = await built(() => createTaobaoLinkOpen({ ...f.options, cache }));
    for (const link of [first, second]) {
      f.f.clock.advanceMs(1000);
      const result = await built(() => service.open({ ...f.request(), linkId: link.link_id }));
      expect(result.envelope.code).toBe(0);
      expect(get.mock.calls.at(-1)![0]).toHaveProperty('linkCode', link.lk);
      expect(put.mock.calls.at(-1)![0]).toHaveProperty('linkCode', link.lk);
    }
    expect(f.convert).toHaveBeenCalledTimes(2);
    const identities = f.convert.mock.calls.map((call) => call[1] as JdPddIdentity);
    expect(
      identities.map((identity) =>
        platform === 'jd' ? identity.subUnionId : identity.custom_parameters?.lk,
      ),
    ).toEqual(
      platform === 'jd' ? ['n_demo0001_cache1', 'n_demo0001_cache2'] : ['cache1', 'cache2'],
    );
    for (const mode of ['disabled', 'null', 'no_rebate'] as const) {
      get.mockClear();
      put.mockClear();
      f.f.config.set(`attr.click_code.${platform}`, mode !== 'disabled');
      f.f.clock.advanceMs(1000);
      const link = {
        ...original,
        link_id: randomUUID(),
        lk: mode === 'null' ? null : `mode${mode === 'disabled' ? '01' : '02'}`,
      };
      await db.insertInto('links').values(link).execute();
      const result = await built(() =>
        service.open({
          ...f.request(),
          linkId: link.link_id,
          noRebate: mode === 'no_rebate',
        }),
      );
      expect(result.envelope.code).toBe(0);
      expect(get).toHaveBeenCalled();
      for (const [key] of [...get.mock.calls, ...put.mock.calls])
        expect(key).not.toHaveProperty('linkCode');
      expect((await row(db, link.link_id)).lk).toBe(link.lk);
    }
  },
);
