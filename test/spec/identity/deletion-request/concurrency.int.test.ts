// B1-15d concurrent applications (08 BR-ID-27; brief §9.2 #3 "users 行锁内判定"): two requests
// with different keys and tokens. The first is held inside the in-flight port (after it locked the
// user's row); the second is sent and the test waits, by polling pg_locks, until it queues behind
// that lock; then the first is released. Both answer 200 with the same request; one open row.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  deletion,
  gate,
  holdInFlight,
  lockWaiter,
  openFixture,
  requests,
  user,
  type Fixture,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-15d#18] 并发两次申请（不同键）→ 只一张未结束单，两次都 200 且返回同一单', async () => {
  const u = await user(f);
  const release = gate();
  const entered = gate();
  holdInFlight(u.appId, u.uid, { hold: release.promise, entered: entered.open });
  const firstToken = await u.mint();
  const secondToken = await u.mint();
  const first = u.apply({ stepUp: firstToken });
  // The first request must reach the in-flight port and stay there (not answer before it).
  const reached = await Promise.race([
    entered.promise.then(() => 'entered' as const),
    first.then((response) => response.payload),
  ]);
  if (reached !== 'entered') release.open();
  expect(reached, 'the first application never reached the in-flight port').toBe('entered');
  const second = u.apply({ stepUp: secondToken });
  try {
    await lockWaiter(f);
  } finally {
    release.open();
  }
  const [a, b] = await Promise.all([first, second]);
  const one = await deletion(a);
  const two = await deletion(b);
  expect(one.status).toBe('cooling');
  expect(two).toEqual(one);
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('cooling');
});
