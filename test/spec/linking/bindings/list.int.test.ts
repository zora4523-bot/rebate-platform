import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { ACCOUNT_NAME, RELATION, suite } from './kit.ts';
import { client } from './client.ts';
import { account, binding, snapshot } from './records.ts';
import { rejected, validate } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['unbound', 'released', 'released_plus_active', 'active', 'invalid', 'blocked'] as const)(
  '[AC-B1-06h#16] 淘宝和拼多多 %s 各投影一项，只有 platform/status',
  async (projection) => {
    const f = use();
    const c = await client(f);
    for (const platform of ['taobao', 'pdd'] as const) {
      const accountId = await account(f, c, platform);
      if (projection === 'released_plus_active') {
        await binding(f, c, accountId, {
          platform,
          status: 'released',
          relation_id: 'synthetic-old-R',
        });
        await binding(f, c, accountId, { platform, status: 'active' });
      } else if (projection !== 'unbound') {
        await binding(f, c, accountId, { platform, status: projection });
      }
    }
    const before = await snapshot(f, c);
    const response = await c.list();
    expect(response.statusCode).toBe(200);
    await validate(response.json(), 'UnionBindingsResponse');
    expect(response.json()).toMatchObject({ code: 0 });
    const items = response.json<{ data: { items: { platform: string; status: string }[] } }>().data
      .items;
    expect(new Set(items.map((item) => item.platform)).size).toBe(items.length);
    const expected = projection === 'released_plus_active' ? 'active' : projection;
    for (const platform of ['taobao', 'pdd']) {
      expect(items.filter((item) => item.platform === platform)).toEqual([
        { platform, status: expected },
      ]);
    }
    for (const item of items) {
      expect(item).toEqual({
        platform: item.platform,
        status: ['taobao', 'pdd'].includes(item.platform) ? expected : 'unbound',
      });
    }
    expect(response.payload).not.toContain(ACCOUNT_NAME);
    expect(response.payload).not.toContain(RELATION);
    expect(await snapshot(f, c)).toEqual(before);
    expect(f.exchange).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06h#16] 他人与其他 app 的绑定不影响本人的未绑定投影', async () => {
  const f = use();
  const c = await client(f);
  const otherUser = await client(f, { appId: c.appId });
  const otherApp = await client(f);
  for (const foreign of [otherUser, otherApp]) {
    for (const platform of ['taobao', 'pdd']) {
      const accountId = await account(f, foreign, platform);
      await binding(f, foreign, accountId, { platform, status: 'blocked' });
    }
  }
  const before = await snapshot(f, c);
  const foreignBefore = await snapshot(f, otherApp);
  const response = await c.list();
  expect(response.statusCode).toBe(200);
  await validate(response.json(), 'UnionBindingsResponse');
  const items = response.json<{ data: { items: { platform: string; status: string }[] } }>().data
    .items;
  expect(new Set(items.map((item) => item.platform)).size).toBe(items.length);
  for (const platform of ['taobao', 'pdd']) {
    expect(items.filter((item) => item.platform === platform)).toEqual([
      { platform, status: 'unbound' },
    ]);
  }
  for (const item of items) expect(item).toEqual({ platform: item.platform, status: 'unbound' });
  expect(response.payload).not.toContain(otherUser.uid);
  expect(response.payload).not.toContain(otherApp.uid);
  expect(await snapshot(f, c)).toEqual(before);
  expect(await snapshot(f, otherApp)).toEqual(foreignBefore);
});

it('[AC-B1-06h#16] GET 无令牌返回 10001', async () => {
  const f = use();
  const c = await client(f);
  const before = await snapshot(f, c);
  await rejected(await c.list({ token: null }), 10001);
  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
});
