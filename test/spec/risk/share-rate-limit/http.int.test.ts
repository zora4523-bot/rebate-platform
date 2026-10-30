import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeHttpSuite, limited, openHttpSuite, type HttpSuite } from '../rate-limit/http-kit.ts';
import { withShares } from './kit.ts';

let suite: HttpSuite;
beforeAll(async () => {
  suite = await openHttpSuite();
}, 180_000);
afterAll(async () => {
  await closeHttpSuite(suite);
});

it('[AC-B1-15x#2] 真签名 POST /v1/shares 与 /v1/links/convert 交替共用缺省 convert 用户桶：第 31 次 429/42901 + Retry-After', async () => {
  await withShares(suite, {}, async (f) => {
    const first = await f.share('share_0');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ code: 0 });
    for (let i = 1; i < 30; i++) {
      const send = i % 2 === 0 ? () => f.share(`share_${i}`) : () => f.convert(`convert_${i}`);
      expect((await send()).json()).toMatchObject({ code: 0 });
    }
    await limited(await f.share('share_30'), 2);
    await limited(await f.convert('convert_30'), 2);
    expect(f.created()).toBe(15);
    // A replay is answered from idempotency before stage ⑬ and spends nothing.
    expect((await f.share('share_0')).json()).toEqual(first.json());
    f.clock.advanceMs(2000);
    expect((await f.share('share_30')).json()).toMatchObject({ code: 0 });
    expect(f.created()).toBe(16);
    await limited(await f.convert('convert_31'), 2);
  });
}, 60_000);

it('[AC-B1-15x#3] 后台 rate_limit.ops 改 createShare 映射（upsert）即时生效：先归 convert，改组按新组，置 null 不限流', async () => {
  await withShares(suite, {}, async (f) => {
    for (let i = 0; i < 30; i++)
      expect((await f.share(`share_${i}`)).json()).toMatchObject({ code: 0 });
    await limited(await f.share('share_30'), 2);
    expect(f.created()).toBe(30);

    await f.config('rate_limit.ops', { createShare: 'share' });
    await f.config('rate_limit.share', { user: [{ limit: 1, window_sec: 60 }] });
    expect((await f.share('share_30')).json()).toMatchObject({ code: 0 });
    await limited(await f.share('share_31'), 60);
    // convertLink keeps the convert group the default mapping emptied.
    await limited(await f.convert('convert_0'), 2);

    await f.config('rate_limit.ops', { createShare: null });
    for (let i = 31; i < 36; i++)
      expect((await f.share(`share_${i}`)).json()).toMatchObject({ code: 0 });
    expect(f.created()).toBe(36);
    await limited(await f.convert('convert_0'), 2);
  });
}, 60_000);
