import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { RedisUnavailableError } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  DEVICE,
  METHODS,
  NONCE,
  NOW,
  SECRET,
  SMS,
  UNSIGNED_HEADERS,
  contract,
  dependencies,
  httpFixture,
  inject,
  input,
  rejected,
  sign,
  signingString,
} from './kit.ts';

it('[BR-ID-09][04 §5] 所有契约签名操作均拒绝无设备；所有非签名操作均不查设备或nonce', async () => {
  const { server, deps } = await httpFixture();
  try {
    let signed = 0;
    let unsigned = 0;
    for (const [path, item] of Object.entries((await contract()).paths)) {
      for (const method of METHODS) {
        const operation = item[method];
        if (operation === undefined) continue;
        const url = path.replace(/\{[^}]+\}/g, 'test-id');
        const request = input({
          method: method.toUpperCase(),
          url,
          rawBody: Buffer.alloc(0),
          headers: operation['x-signed'] === true ? {} : UNSIGNED_HEADERS,
        });
        deps.devices.findActive.mockClear();
        deps.evalScript.mockClear();
        const response = await inject(server, request);
        if (operation['x-signed'] === true) {
          signed += 1;
          await rejected(response, 10402);
        } else {
          unsigned += 1;
          expect(response.statusCode).toBe(200);
          expect(deps.devices.findActive).not.toHaveBeenCalled();
          expect(deps.evalScript).not.toHaveBeenCalled();
        }
      }
    }
    expect(signed).toBeGreaterThan(0);
    expect(unsigned).toBeGreaterThan(0);
    deps.devices.findActive.mockClear();
    deps.evalScript.mockClear();
    for (const url of ['/not-in-contract', `${SMS}/unmatched`]) {
      const response = await server.inject({ method: 'POST', url, headers: UNSIGNED_HEADERS });
      expect(response.statusCode).toBe(404);
    }
    expect(
      (await server.inject({ method: 'GET', url: SMS, headers: UNSIGNED_HEADERS })).statusCode,
    ).toBe(404);
    expect(deps.devices.findActive).not.toHaveBeenCalled();
    expect(deps.evalScript).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

for (const [label, body, validSign, code] of [
  ['错签和损坏JSON', '{"broken":', false, 10401],
  ['正确签名和损坏JSON', '{"broken":', true, 20001],
  ['错签和非法body schema', '{"phone":12}', false, 10401],
  ['正确签名和非法body schema', '{"phone":12}', true, 20001],
] as const) {
  it(`[BR-ID-09][BR-ID-01] 验签先于解析与校验：${label}`, async () => {
    const { server } = await httpFixture({ schema: true });
    try {
      const request = input({ rawBody: Buffer.from(body) });
      const response = await inject(
        server,
        validSign
          ? request
          : { ...request, headers: { ...request.headers, 'x-sign': '0'.repeat(64) } },
      );
      const envelope = await rejected(response, code);
      if (body === '{"broken":' && validSign)
        expect(envelope['data']).toEqual({ fields: ['body'] });
    } finally {
      await server.close();
    }
  });
}

it('[BR-ID-09][BR-ID-01] 大写nonce在契约头校验之前返回10401，未知设备返回10402', async () => {
  const { server } = await httpFixture({ schema: true });
  try {
    const request = input();
    const nonce = NONCE.toUpperCase();
    const malformed = {
      ...request,
      headers: {
        ...request.headers,
        'x-nonce': nonce,
        'x-sign': sign('POST', SMS, request.rawBody, String(NOW), nonce),
      },
    };
    await rejected(await inject(server, malformed), 10401);
    await rejected(
      await inject(server, {
        ...malformed,
        headers: { ...malformed.headers, 'x-device-id': 'unknown' },
        rawBody: Buffer.from('{'),
      }),
      10402,
    );
  } finally {
    await server.close();
  }
});

for (const validSign of [false, true]) {
  it(`[BR-ID-09][BR-ID-01] 不支持的Content-Type在验签之后处理，签名正确=${String(validSign)}`, async () => {
    const { server } = await httpFixture();
    try {
      const request = input({ rawBody: Buffer.from('opaque bytes') });
      const response = await inject(server, {
        ...request,
        headers: {
          ...request.headers,
          'content-type': 'application/x-signature-probe',
          ...(validSign ? {} : { 'x-sign': '0'.repeat(64) }),
        },
      });
      const body = await rejected(response, validSign ? 20001 : 10401, validSign ? 415 : 401);
      if (validSign) expect(body['data']).toEqual({ fields: ['body'] });
    } finally {
      await server.close();
    }
  });
}

for (const [size, validSign] of [
  [65, false],
  [65, true],
  [111, false],
  [111, true],
] as const) {
  it(`[BR-ID-09][CT-01d] 流式body ${size}字节超过64上限先返回413/20001，签名正确=${String(validSign)}`, async () => {
    const { server, deps } = await httpFixture({ bodyLimit: 64 });
    try {
      const rawBody = Buffer.from(JSON.stringify({ text: 'x'.repeat(size - 11) }));
      expect(rawBody.length).toBe(size);
      const request = input({ rawBody });
      const response = await server.inject({
        method: 'POST',
        url: SMS,
        headers: { ...request.headers, ...(validSign ? {} : { 'x-sign': '0'.repeat(64) }) },
        payload: Readable.from([rawBody.subarray(0, 32), rawBody.subarray(32)]),
      });
      const body = await rejected(response, 20001, 413);
      expect(body['data']).toEqual({ fields: ['body'] });
      expect(deps.evalScript).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
}

it('[BR-ID-09] 原始字节跨chunk（含UTF-8字符）验签后原样交还解析器，恰好bodyLimit可通过', async () => {
  const rawBody = Buffer.from('{ "text": "中文👍" }');
  const { server } = await httpFixture({ bodyLimit: rawBody.length });
  try {
    const request = input({ rawBody });
    const response = await server.inject({
      method: 'POST',
      url: SMS,
      headers: request.headers,
      payload: Readable.from([...rawBody].map((byte) => Buffer.from([byte]))),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reached: true,
      body: { text: '中文👍' },
      verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
    });
  } finally {
    await server.close();
  }
});

it('[BR-ID-09][BR-ID-01] 按注册顺序运行后续检查，失败短路且后续能读到已验证设备', async () => {
  const order: string[] = [];
  const second = vi.fn(async (request) => {
    order.push('②');
    expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
  });
  const third = vi.fn(async () => {
    order.push('③');
  });
  const { server } = await httpFixture({ checksAfter: [second, third] });
  try {
    const request = input();
    await rejected(
      await inject(server, {
        ...request,
        headers: { ...request.headers, 'x-sign': '0'.repeat(64) },
      }),
      10401,
    );
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect((await inject(server, request)).statusCode).toBe(200);
    expect(order).toEqual(['②', '③']);
  } finally {
    await server.close();
  }
});

it('[BR-ID-09][ADR-0001 §4.2 第17项] Redis不可用拒绝50001，错签仍10401；日志和响应不含密钥签名串及X-Sign', async () => {
  // B1-01za: unexpected Redis errors use the global filter's unhandled_error log.
  const deps = dependencies();
  deps.evalScript.mockRejectedValue(new RedisUnavailableError('command_timeout'));
  const { server, lines } = await httpFixture({ deps });
  try {
    const request = input();
    const failed = await inject(server, request);
    await rejected(failed, 50001);
    const invalidSign = 'bad10401'.repeat(8);
    const bad = await inject(server, {
      ...request,
      headers: { ...request.headers, 'x-sign': invalidSign },
    });
    await rejected(bad, 10401);
    expect(deps.evalScript).toHaveBeenCalledTimes(1);
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'unhandled_error', trace_id: request.id }),
    );
    for (const secret of [
      SECRET,
      String(request.headers['x-sign']),
      invalidSign,
      signingString('POST', SMS, request.rawBody, String(NOW), NONCE),
    ]) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      expect(lines.join('\n')).not.toContain(escaped);
      expect(failed.body + bad.body).not.toContain(escaped);
    }
  } finally {
    await server.close();
  }
});

it('[BR-ID-09][B1-01za] 密钥查询/解密异常是50001而非10402，且不写nonce', async () => {
  const deps = dependencies();
  deps.devices.findActive.mockRejectedValue(new Error('field decryption failed'));
  const { server } = await httpFixture({ deps });
  try {
    await rejected(await inject(server), 50001);
    expect(deps.evalScript).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it('[BR-ID-09] 有效签名通过真实契约头/body校验，空body按零字节签名', async () => {
  const { server } = await httpFixture({ schema: true });
  try {
    const response = await inject(server);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reached: true,
      body: { phone: '13800138000', purpose: 'login' },
    });
    const url = '/v1/me/deletion';
    const nonce = 'a1'.repeat(16);
    const empty = input({ url, rawBody: Buffer.alloc(0) });
    const emptyResponse = await inject(server, {
      ...empty,
      headers: {
        ...empty.headers,
        'content-type': undefined,
        'x-nonce': nonce,
        'x-sign': sign('POST', url, Buffer.alloc(0), String(NOW), nonce),
      },
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toMatchObject({
      reached: true,
      verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
    });
  } finally {
    await server.close();
  }
});

it('[BR-ID-09] HTTP匹配模板后仍按原始转义path/query验签，不排序或解码', async () => {
  const { server } = await httpFixture();
  try {
    const url = '/v1/links/a%2Fb/open?b=2&a=%2f&tag=z&tag=x&empty=';
    const request = input({ url });
    const normalized = '/v1/links/a/b/open?a=/&b=2&tag=x&empty=';
    await rejected(
      await inject(server, {
        ...request,
        headers: {
          ...request.headers,
          'x-sign': sign('POST', normalized, request.rawBody, String(NOW), NONCE),
        },
      }),
      10401,
    );
    expect((await inject(server, request)).statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

it('[BR-ID-09][ADR-0001 §4.2 第17项] 没有Redis提供者时签名请求失败关闭，不签名请求仍可通过', async () => {
  const { server } = await httpFixture({ withoutRedis: true });
  try {
    await rejected(await inject(server), 50001);
    expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const bad = input();
    await rejected(
      await inject(server, { ...bad, headers: { ...bad.headers, 'x-sign': '0'.repeat(64) } }),
      10401,
    );
  } finally {
    await server.close();
  }
});

it('[BR-ID-01][B1-01za] 后续检查也早于JSON解析，失败后不调用剩余检查', async () => {
  // BR-ID-01 puts stages ②/③ before body validation too; the shared preParsing hook preserves it.
  const last = vi.fn(async () => undefined);
  const middle = vi.fn(async () => {
    throw new Error('later check rejected');
  });
  const { server } = await httpFixture({ checksAfter: [middle, last] });
  try {
    await rejected(await inject(server, input({ rawBody: Buffer.from('{') })), 50001);
    expect(middle).toHaveBeenCalledTimes(1);
    expect(last).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
