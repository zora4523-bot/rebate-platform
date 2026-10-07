import { expect, it } from 'vitest';
import { originFormTarget } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { sign, NOW, NONCE, TRACE, type Response } from '../../risk/signature/kit.ts';
import { HEADERS, PRINCIPAL, routeFor } from './kit.ts';
import { httpFixture } from './http-kit.ts';

async function rejection(response: Response, code: number) {
  expect(response.statusCode).toBe(code === 10403 ? 403 : 401);
  const body = response.json();
  const validate = await envelopeValidator();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body).toMatchObject({ code, trace_id: TRACE });
  expect(body).not.toHaveProperty('data');
}

for (const payload of ['{"broken":', 'x'.repeat(1024)]) {
  it(`[BR-ID-01][BR-ID-10] 非签名logout缺令牌先于坏头/请求体校验，且不先缓冲${payload.length}字节`, async () => {
    const { server, handled } = await httpFixture();
    try {
      await rejection(
        await server.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { 'content-type': 'application/json' },
          payload,
        }),
        10001,
      );
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 30_000);
}

it('[BR-ID-01] ①签名错误优先于②缺令牌和损坏JSON，处理函数不执行', async () => {
  const { server, handled } = await httpFixture();
  try {
    const route = await routeFor('login', true);
    const url = route.path.replace(/:[^/]+/g, 'test-id');
    await rejection(
      await server.inject({
        method: route.method,
        url,
        headers: {
          ...HEADERS,
          'x-timestamp': String(NOW),
          'x-nonce': NONCE,
          'x-sign': '0'.repeat(64),
          'content-type': 'application/json',
        },
        payload: '{"broken":',
      }),
      10401,
    );
    expect(handled).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
}, 30_000);

it('[BR-ID-01] ③ App拒绝先于坏头和损坏JSON，10002优先于App不一致', async () => {
  const { server, handled, tokens } = await httpFixture();
  try {
    const token = await tokens.issueAccess(PRINCIPAL);
    for (const [authorization, code] of [
      [`Bearer ${token}`, 10403],
      ['Bearer invalid', 10002],
    ] as const) {
      await rejection(
        await server.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { authorization, 'content-type': 'application/json', 'x-app-id': 'other' },
          payload: '{"broken":',
        }),
        code,
      );
    }
    expect(handled).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
}, 30_000);

it('[BR-ID-07][04 §5] 注册点把服务端主体传到HTTP处理函数，日志不泄露令牌私钥', async () => {
  const { server, handled, tokens, keyring, lines } = await httpFixture();
  try {
    const token = await tokens.issueAccess(PRINCIPAL);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ principal: PRINCIPAL });
    expect(handled).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(token);
    expect(lines.join('')).not.toContain(
      keyring.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
  } finally {
    await server.close();
  }
}, 30_000);

for (const absolute of [false, true]) {
  it(`[BR-ID-01][BR-ID-07] ${absolute ? 'rewriteUrl absolute-form' : '*v1可匹配目标'} 的签名通过后仍受令牌守卫保护`, async () => {
    const { server, handled } = await httpFixture();
    try {
      const route = await routeFor('login', true);
      const path = route.path.replace(/:[^/]+/g, 'test-id');
      const target = absolute ? `https://example.test${path}` : `*${path.slice(1)}`;
      expect(originFormTarget(target)).toBe(absolute ? path : target);
      const signature = sign(
        route.method,
        absolute ? path : target,
        Buffer.alloc(0),
        String(NOW),
        NONCE,
      );
      await rejection(
        await server.inject({
          method: route.method,
          url: path,
          headers: {
            ...HEADERS,
            'x-test-raw-target': target,
            'x-timestamp': String(NOW),
            'x-nonce': NONCE,
            'x-sign': signature,
          },
        }),
        10001,
      );
      expect(handled).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 30_000);
}
