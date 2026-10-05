import { expect, it } from 'vitest';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import { RedisUnavailableError } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { contractSigningRoutes } from '../../../../apps/api/src/modules/platform/validation/signing-routes.ts';
import {
  DEVICE,
  METHODS,
  NONCE,
  NOW,
  SECRET,
  SMS,
  contract,
  dependencies,
  input,
  sign,
  template,
  vectorInput,
  vectors,
} from './kit.ts';

it('[BR-ID-09][04 §5] 签名表与契约全部操作一致，包含 planned，缺省为不签名', async () => {
  const expected = [];
  for (const [path, item] of Object.entries((await contract()).paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation !== undefined)
        expected.push({
          method: method.toUpperCase(),
          path: template(path),
          signed: operation['x-signed'] === true,
        });
    }
  }
  const order = (a: { method: string; path: string }, b: { method: string; path: string }) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
  expect([...contractSigningRoutes()].sort(order)).toEqual(expected.sort(order));
});

for (const vector of vectors.valid_cases) {
  it(`[BR-ID-09] 共用有效向量：${vector.note}`, async () => {
    const deps = dependencies();
    deps.clock.set(new Date(vector.server_time * 1000));
    deps.rows.set(DEVICE, {
      deviceId: DEVICE,
      appId: 'couli',
      installSecret: vector.install_secret,
    });
    const check = createSignatureCheck(deps);
    const request = vectorInput(vector);
    await check(request);
    expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
    expect(deps.evalScript).toHaveBeenCalledTimes(1);
  });
}

for (const vector of vectors.invalid_cases) {
  it(`[BR-ID-09] 共用无效向量返回10401且不占nonce：${vector.note}`, async () => {
    const deps = dependencies();
    deps.clock.set(new Date(vector.server_time * 1000));
    deps.rows.set(DEVICE, {
      deviceId: DEVICE,
      appId: 'couli',
      installSecret: vector.install_secret,
    });
    const check = createSignatureCheck(deps);
    await expect(check(vectorInput(vector))).rejects.toMatchObject({ code: 10401 });
    expect(deps.evalScript).not.toHaveBeenCalled();
  });
}

for (const device of [
  undefined,
  '',
  'not-a-server-issued-device',
  '019a0000-0000-7000-8000-000000000099',
]) {
  it(`[BR-ID-09][BR-ID-01] 设备缺失或未签发先于其他错误返回10402：${String(device)}`, async () => {
    const deps = dependencies();
    const check = createSignatureCheck(deps);
    const request = input({
      headers: { 'x-device-id': device, 'x-timestamp': 'bad', 'x-sign': 'bad' },
    });
    await expect(check(request)).rejects.toMatchObject({ code: 10402 });
    expect(request.verifiedDevice).toBeUndefined();
    expect(deps.evalScript).not.toHaveBeenCalled();
  });
}

for (const header of ['x-timestamp', 'x-nonce', 'x-sign']) {
  for (const value of [undefined, '', 'invalid']) {
    it(`[BR-ID-09] 有效设备的签名头缺失或非法返回10401：${header}=${String(value)}`, async () => {
      const deps = dependencies();
      const check = createSignatureCheck(deps);
      const request = input();
      await expect(
        check({ ...request, headers: { ...request.headers, [header]: value } }),
      ).rejects.toMatchObject({ code: 10401 });
      expect(deps.evalScript).not.toHaveBeenCalled();
    });
  }
}

it('[BR-ID-09] X-Sign只接受64位小写hex，长短、大小写和首尾篡改均不通过', async () => {
  const deps = dependencies();
  const check = createSignatureCheck(deps);
  const request = input();
  const valid = String(request.headers['x-sign']);
  const flip = (char: string) => (char === '0' ? '1' : '0');
  for (const signature of [
    valid.toUpperCase(),
    valid.slice(1),
    `${valid}0`,
    `g${valid.slice(1)}`,
    flip(valid[0]!) + valid.slice(1),
    valid.slice(0, -1) + flip(valid.at(-1)!),
  ]) {
    await expect(
      check({ ...request, headers: { ...request.headers, 'x-sign': signature } }),
    ).rejects.toMatchObject({ code: 10401 });
  }
  expect(deps.evalScript).not.toHaveBeenCalled();
});

it('[BR-ID-09] HMAC绑定方法、原始query编码及顺序、原始body字节和设备密钥', async () => {
  const deps = dependencies();
  const check = createSignatureCheck(deps);
  const url = `${SMS}?b=2&a=%2f&tag=x&tag=y&empty=`;
  const body = Buffer.from('{ "text": "中文👍" }');
  const original = input({ url, rawBody: body });
  const requests = [
    { ...original, url: `${SMS}?a=%2f&b=2&tag=x&tag=y&empty=` },
    { ...original, url: url.replace('%2f', '%2F') },
    { ...original, url: url.replace('&tag=x', '') },
    { ...original, rawBody: Buffer.from('{"text":"中文👍"}') },
    { ...original, rawBody: Buffer.concat([body, Buffer.from('\n')]) },
    {
      ...original,
      headers: { ...original.headers, 'x-sign': sign('GET', url, body, String(NOW), NONCE) },
    },
    {
      ...original,
      headers: {
        ...original.headers,
        'x-sign': sign('POST', url, body, String(NOW), NONCE, `${SECRET}-wrong`),
      },
    },
  ];
  for (const request of requests)
    await expect(check(request)).rejects.toMatchObject({ code: 10401 });
  expect(deps.evalScript).not.toHaveBeenCalled();
  await check(original);
  expect(original.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
});

it('[BR-ID-09][BR-ID-01] 错签不占nonce且优先于Redis故障，修正后可成功一次', async () => {
  const deps = dependencies();
  deps.evalScript.mockRejectedValueOnce(new RedisUnavailableError('command_failed', null));
  const check = createSignatureCheck(deps);
  const request = input();
  await expect(
    check({ ...request, headers: { ...request.headers, 'x-sign': '0'.repeat(64) } }),
  ).rejects.toMatchObject({ code: 10401 });
  expect(deps.evalScript).not.toHaveBeenCalled();
  await expect(check(request)).rejects.toBeInstanceOf(RedisUnavailableError);
  expect(request.verifiedDevice).toBeUndefined();
  await check(request);
  expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
  await expect(check(input())).rejects.toMatchObject({ code: 10401 });
});

it('[BR-ID-09][BR-ID-01] nonce使用设备行app_id；①不比较客户端X-App-Id', async () => {
  const deps = dependencies();
  const check = createSignatureCheck(deps);
  const first = input();
  const request = { ...first, headers: { ...first.headers, 'x-app-id': 'different-app' } };
  await check(request);
  expect(request.verifiedDevice).toEqual({ deviceId: DEVICE, appId: 'couli' });
  expect(deps.redis.namespace).toHaveBeenCalledWith('risk');
  expect(deps.evalScript).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ keys: [`nonce:couli:${DEVICE}:${NONCE}`], ttlSeconds: 600 }),
  );
  await expect(check(input())).rejects.toMatchObject({ code: 10401 });
});

it('[BR-ID-09] 相同nonce允许不同设备使用；吊销后不得依赖旧查询结果继续放行', async () => {
  const deps = dependencies();
  const check = createSignatureCheck(deps);
  await check(input());
  const other = '019a0000-0000-7000-8000-000000000002';
  deps.rows.set(other, { deviceId: other, appId: 'couli', installSecret: SECRET });
  const second = input();
  await check({ ...second, headers: { ...second.headers, 'x-device-id': other } });
  expect(deps.reserved.size).toBe(2);
  deps.rows.delete(DEVICE);
  await expect(check(input())).rejects.toMatchObject({ code: 10402 });
});

it('[BR-ID-09] 秒级时间窗读取注入时钟，客户端时钟头不能扩大窗口', async () => {
  const deps = dependencies();
  deps.clock.advanceMs(301_000);
  const check = createSignatureCheck(deps);
  const request = input();
  await expect(
    check({
      ...request,
      headers: {
        ...request.headers,
        'x-clock-now': String(NOW),
        date: new Date(NOW * 1000).toUTCString(),
      },
    }),
  ).rejects.toMatchObject({ code: 10401 });
  expect(deps.evalScript).not.toHaveBeenCalled();
});
