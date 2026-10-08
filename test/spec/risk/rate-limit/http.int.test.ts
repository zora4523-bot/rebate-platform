import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openHttpSuite, closeHttpSuite, withHttp, limited, type HttpSuite } from './http-kit.ts';

let suite: HttpSuite;
beforeAll(async () => {
  suite = await openHttpSuite();
}, 180_000);
afterAll(async () => {
  await closeHttpSuite(suite);
});

const TIP = '/v1/me/tips/jump_tip/read';
const PARSE = '/v1/inputs/parse';
const CONVERT = '/v1/links/convert';
const TEXT = { text: '今天心情很好', scene: 'clipboard' };
const CONVERSION = {
  platform: 'jd',
  product_key: 'jd:i_100012043978',
  scene: 'h5',
  installed: 'unknown',
};

it('[AC-B1-03e#13] AppModule 经 content 读取 ops 和阈值，HTTP 42901/Retry-After 符合契约，不写 risk_hits', async () => {
  await withHttp(
    suite,
    {
      'rate_limit.ops': { markTipRead: 'tips' },
      'rate_limit.tips': { user: [{ limit: 2, window_sec: 60 }] },
    },
    async (f) => {
      for (let i = 0; i < 2; i++)
        expect((await f.post(TIP, { platform: 'taobao' })).json()).toMatchObject({ code: 0 });
      await limited(await f.post(TIP, { platform: 'taobao' }), 30);
      expect(f.handled()).toBe(2);
      const hits = await sql`SELECT id FROM app.risk_hits WHERE app_id = ${f.id}`.execute(
        suite.kit.db,
      );
      expect(hits.rows).toEqual([]);
      f.clock.advanceMs(30_000);
      expect((await f.post(TIP, { platform: 'taobao' })).json()).toMatchObject({ code: 0 });
      await limited(await f.post(TIP, { platform: 'taobao' }), 30);
    },
  );
});

it('[AC-B1-03e#14] 真签名非幂等接口：①②③失败不扣令牌，④a低版本优先于已耗尽的⑬', async () => {
  await withHttp(
    suite,
    {
      'rate_limit.ops': { parseInput: 'parse' },
      'rate_limit.parse': { user: [{ limit: 1, window_sec: 60 }] },
    },
    async (f) => {
      expect((await f.post(PARSE, TEXT, { 'x-sign': '0'.repeat(64) })).json()).toMatchObject({
        code: 10401,
      });
      expect((await f.post(PARSE, TEXT, { authorization: 'Bearer invalid' })).json()).toMatchObject(
        { code: 10002 },
      );
      expect((await f.post(PARSE, TEXT, { 'x-app-id': 'wrong_app' })).json()).toMatchObject({
        code: 10403,
      });
      expect((await f.post(PARSE, TEXT)).json()).toMatchObject({ code: 30132 });
      await limited(await f.post(PARSE, TEXT), 60);
      const obsolete = await f.post(PARSE, TEXT, { 'x-app-version': '1.0.0' });
      expect(obsolete.statusCode).toBe(403);
      expect(obsolete.json()).toMatchObject({
        code: 10405,
        data: { min_supported_version: '2.0.0' },
      });
      f.clock.advanceMs(60_000);
      // A low-version request with a full bucket also cannot spend its available token.
      expect((await f.post(PARSE, TEXT, { 'x-app-version': '1.0.0' })).json()).toMatchObject({
        code: 10405,
      });
      expect((await f.post(PARSE, TEXT)).json()).toMatchObject({ code: 30132 });
      await limited(await f.post(PARSE, TEXT), 60);
    },
  );
});

for (const transactional of [false, true]) {
  it(`[AC-B1-03e#15] 真签名幂等 ${transactional ? 'executeInTransaction' : 'execute'}：回放不扣桶，未命中在④a之后，429不占键`, async () => {
    await withHttp(
      suite,
      {
        'rate_limit.convert': { user: [{ limit: 2, window_sec: 60 }] },
      },
      async (f) => {
        const send = (key: string, version = '2.0.0') =>
          f.post(CONVERT, CONVERSION, { 'idempotency-key': key, 'x-app-version': version });
        const first = await send('rate_limit_a');
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({ code: 0 });
        for (let i = 0; i < 4; i++)
          expect((await send('rate_limit_a')).json()).toEqual(first.json());
        expect((await send('rate_limit_b')).json()).toMatchObject({ code: 0 });
        await limited(await send('rate_limit_c'), 30);
        expect(f.handled()).toBe(2);
        expect((await send('rate_limit_a', '1.0.0')).json()).toEqual(first.json());
        expect((await send('rate_limit_d', '1.0.0')).json()).toMatchObject({ code: 10405 });
        const stored = await sql<{
          key: string;
        }>`SELECT key FROM app.idempotency_keys WHERE app_id = ${f.id} ORDER BY key`.execute(
          suite.kit.db,
        );
        expect(stored.rows.map((row) => row.key)).toEqual(['rate_limit_a', 'rate_limit_b']);
        f.clock.advanceMs(30_000);
        expect((await send('rate_limit_c')).json()).toMatchObject({ code: 0 });
        expect(f.handled()).toBe(3);
        await limited(await send('rate_limit_d'), 30);
      },
      transactional,
    );
  });
}

it('[AC-B1-03e#16] 匿名签名取 verifiedDevice；没有用户也不能绕过设备桶', async () => {
  await withHttp(
    suite,
    {
      'rate_limit.ops': { parseInput: 'parse' },
      'rate_limit.parse': { device: [{ limit: 1, window_sec: 60 }] },
    },
    async (f) => {
      expect((await f.post(PARSE, TEXT, { authorization: '' })).json()).toMatchObject({
        code: 30132,
      });
      await limited(await f.post(PARSE, TEXT, { authorization: '' }), 60);
    },
  );
});

it('[AC-B1-03e#17] 实际 searchProducts 用客户端 IP；匿名不读未验证设备头，换 IP 才获得新桶', async () => {
  await withHttp(
    suite,
    {
      'rate_limit.search': { ip: [{ limit: 1, window_sec: 60 }] },
    },
    async (f) => {
      const search = (ip: string, device: string) =>
        f.app.inject({
          method: 'GET',
          url: '/v1/products/search?platform=taobao&q=test',
          remoteAddress: ip,
          headers: { ...f.headers, 'x-device-id': device },
        });
      // Upstream/business availability is outside this task; all assertions below target the gate.
      const first = await search('192.0.2.60', f.device_id);
      expect(first.json<{ code: number }>().code).not.toBe(42901);
      expect(first.statusCode).not.toBe(500);
      await limited(await search('192.0.2.60', '019a0000-0000-7000-8000-000000000001'), 60);
      expect((await search('192.0.2.61', f.device_id)).json<{ code: number }>().code).not.toBe(
        42901,
      );
      await limited(await search('192.0.2.61', f.device_id), 60);
    },
  );
});

it('[AC-B1-03e#18] 关闭 Redis 的无签名受限接口拒绝 42901 + Retry-After:1，并发仅首次 error', async () => {
  await withHttp(
    suite,
    {
      'rate_limit.ops': { markTipRead: 'tips' },
      'rate_limit.tips': { user: [{ limit: 10, window_sec: 60 }] },
    },
    async (f) => {
      expect((await f.post(TIP, { platform: 'taobao' })).json()).toMatchObject({ code: 0 });
      await f.redis.close();
      const replies = await Promise.all(
        Array.from({ length: 8 }, () => f.post(TIP, { platform: 'taobao' })),
      );
      for (const response of replies) await limited(response, 1);
      expect(f.handled()).toBe(1);
      const alerts = f.lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['msg'] === 'rate_limit_store_unavailable');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!['level']).toBe(50);
      expect(JSON.stringify(alerts)).not.toContain(f.uid);
      expect(JSON.stringify(alerts)).not.toContain(f.device_id);
    },
  );
});

it('[AC-B1-03e#19] 未分组接口多次请求仍不限流，默认接口不会因此漏装 guard', async () => {
  await withHttp(
    suite,
    { 'rate_limit.search': { ip: [{ limit: 1, window_sec: 60 }] } },
    async (f) => {
      for (let i = 0; i < 130; i++)
        expect((await f.post(TIP, { platform: 'taobao' })).json()).toMatchObject({ code: 0 });
      const search = () =>
        f.app.inject({
          method: 'GET',
          url: '/v1/products/search?platform=taobao&q=test',
          headers: f.headers,
        });
      expect((await search()).json<{ code: number }>().code).not.toBe(42901);
      await limited(await search(), 60);
    },
  );
}, 30_000);
