import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { fixture as openFixture, outcome, service } from '../open-pdd-auth/kit.ts';
import { noConversion, response } from '../open-pdd-auth/assertions.ts';
import { fixture as listFixture, listed, snapshot } from '../bindings-pdd-query/kit.ts';
import { occupyQueries } from './query-kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['open', 'list'] as const)(
  '[AC-B1-06za#6] %s 占用的第八个查询名额也限制另一个入口；跨实例/租户共用计数',
  async (source) => {
    const open = await openFixture(database(), { binding: 'invalid', query: true });
    const list = await listFixture(database(), 'invalid');
    const openBefore = await open.bindings();
    const listBefore = await snapshot(list);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const producerQuery = source === 'open' ? open.query : list.query;
    const consumerQuery = source === 'open' ? list.query : open.query;
    producerQuery.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { authorized: true };
    });
    const load = await occupyQueries(7);
    const callOpen = () => outcome(() => service(open).open(open.request()));
    const running = source === 'open' ? callOpen() : list.list();
    try {
      expect(load.client.query).toHaveBeenCalledTimes(7);
      await Promise.race([entered.promise, running]);
      expect(producerQuery).toHaveBeenCalledTimes(1);
      if (source === 'open') {
        await listed(await list.list(), 'invalid');
        expect(await snapshot(list)).toEqual(listBefore);
        expect(list.logger.warn).toHaveBeenCalled();
      } else {
        await response(await callOpen(), 50303, 503);
        expect(await open.bindings()).toEqual(openBefore);
        expect(await open.sessions()).toEqual([]);
        await noConversion(open);
        // Existing query-failure audit is permitted; no external jump attempt is written.
        expect(await open.logs()).toEqual([expect.objectContaining({ result_code: 50303 })]);
      }
      expect(consumerQuery).not.toHaveBeenCalled();
      expect(load.client.query).toHaveBeenCalledTimes(7);
      release.resolve();
      if (source === 'open') await response(await running, 0, 200);
      else await listed(await running, 'active');
      // Keep the seven synthetic occupants held to prove exactly one slot was returned.
      if (source === 'open') await listed(await list.list(), 'active');
      else await response(await callOpen(), 0, 200);
      expect(consumerQuery).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await running;
      await load.close();
    }
  },
  60_000,
);
