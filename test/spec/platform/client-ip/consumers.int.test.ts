import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  closeSuite,
  hash,
  limited as deviceLimited,
  openSuite,
  registered,
  withHttp as withDevices,
} from '../../risk/device-register/kit.ts';
import {
  limited as rateLimited,
  withHttp as withRateLimit,
} from '../../risk/rate-limit/http-kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { outbox, responseValidator } from '../../identity/sms-codes/http-kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import { validate as validateLogin } from '../../identity/sms-login/http-kit.ts';
import {
  CLIENT_A,
  CLIENT_B,
  GATEWAY,
  TRUSTED,
  loggedIp,
  validateResponse,
  withProxyConfig,
} from './kit.ts';

let suite: Awaited<ReturnType<typeof openSuite>>;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});

it('[AC-B1-03m#1][AC-B1-03m#7] 未配代理按 socket 占名额；配代理后 A 第三台限流、B 独立注册', async () => {
  for (const trusted of [undefined, TRUSTED]) {
    await withProxyConfig(trusted, async () => {
      await withDevices(suite, { 'device.ip_register_per_hour': 2 }, async (f) => {
        const traces: { trace: string; expected: string }[] = [];
        const send = (client: string, socket = GATEWAY) => {
          const trace = randomUUID();
          traces.push({ trace, expected: trusted === undefined ? socket : client });
          return f.send(socket, hash(), f.id, {
            'x-forwarded-for': client,
            'x-trace-id': trace,
          });
        };
        await registered(await send(CLIENT_A));
        await registered(await send(CLIENT_A));
        await deviceLimited(await send(CLIENT_A));
        if (trusted === undefined) {
          // Varying XFF cannot purchase a new slot when the real peer is unchanged.
          await deviceLimited(await send(CLIENT_B));
          await registered(await send(CLIENT_A, '192.0.2.10'));
        } else {
          await registered(await send(CLIENT_B));
          // The new client's admission did not reset or move A's counter.
          await deviceLimited(await send(CLIENT_A));
        }
        expect(await f.rows()).toHaveLength(3);
        for (const { trace, expected } of traces) loggedIp(f.lines, trace, expected);
      });
    });
  }
}, 30_000);

it('[AC-B1-03m#7] 搜索⑬与设备注册共用可信代理取法：A 第二次 42901，B 仍放行', async () => {
  await withProxyConfig(TRUSTED, async () => {
    await withRateLimit(
      suite,
      { 'rate_limit.search': { ip: [{ limit: 1, window_sec: 60 }] } },
      async (f) => {
        const traces: { trace: string; client: string }[] = [];
        const search = (client: string) => {
          const trace = randomUUID();
          traces.push({ trace, client });
          return f.app.inject({
            method: 'GET',
            url: '/v1/products/search?platform=taobao&q=test',
            remoteAddress: GATEWAY,
            headers: { ...f.headers, 'x-forwarded-for': client, 'x-trace-id': trace },
          });
        };
        const a = await search(CLIENT_A);
        // Business availability is independent of the IP gate. A permitted request must reach
        // a catalog response, not a different guard, a missing route or an internal exception.
        expect([0, 30131, 50304]).toContain(a.json<{ code: number }>().code);
        expect([200, 422, 503]).toContain(a.statusCode);
        await validateResponse('/v1/products/search', 'get', a);
        await rateLimited(await search(CLIENT_A), 60);
        const b = await search(CLIENT_B);
        expect(b.json<{ code: number }>().code).toBe(a.json<{ code: number }>().code);
        expect(b.statusCode).toBe(a.statusCode);
        await validateResponse('/v1/products/search', 'get', b);
        await rateLimited(await search(CLIENT_B), 60);
        for (const { trace, client } of traces) loggedIp(f.lines, trace, client);
      },
    );
  });
}, 30_000);

it('[AC-B1-03m#7] 真签名短信发码和登录的请求日志记录客户端 A/B，均不记录网关地址', async () => {
  await withProxyConfig(TRUSTED, async () => {
    await withDevices(suite, { 'device.ip_register_per_hour': 2 }, async (f) => {
      for (const client of [CLIENT_A, CLIENT_B]) {
        const device = await registered(
          await f.send(GATEWAY, hash(), f.id, { 'x-forwarded-for': client }),
        );
        const post = (path: string, body: Record<string, unknown>, trace: string) => {
          const payload = JSON.stringify(body);
          const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
          const nonce = randomBytes(16).toString('hex');
          return f.app.inject({
            method: 'POST',
            url: path,
            remoteAddress: GATEWAY,
            payload,
            headers: {
              'content-type': 'application/json',
              'x-app-id': f.id,
              'x-platform': 'ios',
              'x-app-version': '2.0.0',
              'x-device-id': device.device_id,
              'x-timestamp': timestamp,
              'x-nonce': nonce,
              'x-sign': sign(
                'POST',
                path,
                Buffer.from(payload),
                timestamp,
                nonce,
                device.install_secret,
              ),
              'x-forwarded-for': client,
              'x-trace-id': trace,
            },
          });
        };
        const number = phone();
        const sendTrace = randomUUID();
        const sent = await post(
          '/v1/auth/sms-codes',
          { phone: number, purpose: 'login' },
          sendTrace,
        );
        expect(sent.statusCode).toBe(200);
        expect(sent.json()).toMatchObject({ code: 0, trace_id: sendTrace });
        const { validate } = await responseValidator();
        expect(validate(sent.json())).toBe(true);
        const message = outbox(f.app).findLast(
          (item) => item.phone === number && item.purpose === 'login',
        );
        expect(message?.code).toMatch(/^[0-9]{6}$/);
        const loginTrace = randomUUID();
        const loggedIn = await post(
          '/v1/auth/login/sms',
          {
            phone: number,
            code: message!.code,
            legal_versions: { privacy: 7, agreement: 4 },
            consent_at: f.clock.now().toISOString(),
          },
          loginTrace,
        );
        expect(loggedIn.statusCode).toBe(200);
        expect(loggedIn.json()).toMatchObject({ code: 0, trace_id: loginTrace });
        await validateLogin(loggedIn, true);
        // Per §9.3 these endpoints are observable through logs until B1-03g provides IP limits.
        loggedIp(f.lines, sendTrace, client);
        loggedIp(f.lines, loginTrace, client);
      }
    });
  });
}, 30_000);
