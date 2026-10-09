import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { suite } from './kit.ts';
import { client, web } from './client.ts';
import { account, binding, snapshot, state } from './records.ts';
import { rejected } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

// BR-ID-24 explicitly preserves blocked -> 30153 during site authorization expiry.
it('[AC-B1-06h#10][AC-B1-06h#11] 站长授权 expired 时 blocked 仍回 30153，state 与绑定原样', async () => {
  const f = use();
  const c = await client(f);
  const accountId = await account(f, c, 'taobao', 'expired');
  const s = await state(f, c);
  await binding(f, c, accountId, { status: 'blocked' });
  const before = await snapshot(f, c);

  await rejected(await c.post(web(s.state)), 30153);

  expect(await snapshot(f, c)).toEqual(before);
  expect(f.exchange).not.toHaveBeenCalled();
});
