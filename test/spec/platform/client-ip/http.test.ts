import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { HttpApp } from '../../risk/rate-limit/http-kit.ts';
import {
  CLIENT_A,
  GATEWAY,
  TRUSTED,
  loggedIp,
  proxyConfig,
  validateResponse,
  withEntry,
} from './kit.ts';

async function observe(
  app: HttpApp,
  lines: string[],
  socket: string,
  forwarded: string | undefined,
  expected: string,
) {
  const trace = randomUUID();
  const response = await app.inject({
    method: 'GET',
    url: '/healthz',
    remoteAddress: socket,
    headers: {
      'x-trace-id': trace,
      ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }),
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, trace_id: trace });
  await validateResponse('/healthz', 'get', response);
  loggedIp(lines, trace, expected);
}

it.each(['api', 'stream', 'admin'] as const)(
  '[AC-B1-03m#1][AC-B1-03m#2] %s 缺省、空串、手工缺字段不信任 XFF；显式网段才启用',
  async (entry) => {
    const manual = { ...proxyConfig(TRUSTED) };
    // Simulate an older hand-built config even after AppConfig gains the required field.
    Reflect.deleteProperty(manual, 'trustedProxies');
    for (const config of [proxyConfig(), proxyConfig(''), manual]) {
      await withEntry(entry, config, async (app, lines) => {
        await observe(app, lines, GATEWAY, '192.0.2.66, 203.0.113.5', GATEWAY);
      });
    }
    // Same request with explicit trust is a positive control: a permanently disabled adapter
    // must fail this test as well as an adapter that always trusts forwarded headers.
    await withEntry(entry, proxyConfig(TRUSTED), async (app, lines) => {
      await observe(app, lines, GATEWAY, CLIENT_A, CLIENT_A);
    });
  },
  30_000,
);

it.each([
  [TRUSTED, GATEWAY, '192.0.2.66, 203.0.113.5', CLIENT_A],
  // Closest proxy first during traversal: two trusted ranges, then the first untrusted hop.
  ['198.51.100.0/24,192.0.2.0/24', GATEWAY, '203.0.113.66, 203.0.113.5, 192.0.2.10', CLIENT_A],
  // A trusted-looking address to the left of an untrusted intermediary cannot move the boundary.
  [TRUSTED, GATEWAY, '203.0.113.66, 198.51.100.20, 192.0.2.10', '192.0.2.10'],
  [TRUSTED, GATEWAY, '192.0.2.66, 198.51.100.20', '192.0.2.66'],
] as const)(
  '[AC-B1-03m#3] 信任链 %s / socket=%s / XFF=%s 取最右不可信地址',
  async (trusted, socket, forwarded, expected) => {
    await withEntry('api', proxyConfig(trusted), async (app, lines) => {
      await observe(app, lines, socket, forwarded, expected);
    });
  },
  30_000,
);

it('[AC-B1-03m#4] 同一配置按直连对端判断信任，直连伪造 XFF 无效；缺头保留 socket', async () => {
  await withEntry('api', proxyConfig(TRUSTED), async (app, lines) => {
    await observe(app, lines, '192.0.2.10', '203.0.113.66, 198.51.100.20', '192.0.2.10');
    await observe(app, lines, '198.51.101.10', CLIENT_A, '198.51.101.10');
    await observe(app, lines, GATEWAY, undefined, GATEWAY);
    await observe(app, lines, GATEWAY, CLIENT_A, CLIENT_A);
  });
}, 30_000);

it.each([
  [TRUSTED, '::ffff:198.51.100.10', CLIENT_A],
  ['2001:db8:1::/48', '2001:db8:1::10', '2001:db8:2::5'],
  ['2001:db8:1::10', '2001:db8:1::10', CLIENT_A],
  ['198.51.100.10', GATEWAY, '2001:db8:2::5'],
] as const)(
  '[AC-B1-03m#5] IPv6、IPv4 映射与精确地址：%s 信任 socket=%s',
  async (trusted, socket, client) => {
    await withEntry('api', proxyConfig(trusted), async (app, lines) => {
      await observe(app, lines, socket, client, client);
      const untrusted = socket.includes(':') ? '2001:db8:3::10' : '198.51.100.11';
      await observe(app, lines, untrusted, client, untrusted);
    });
  },
  30_000,
);
