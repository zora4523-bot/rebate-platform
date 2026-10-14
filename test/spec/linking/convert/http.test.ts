import { expect, it } from 'vitest';
import { body, data, traceId, withHttp } from './http-kit.ts';
import { validate } from './kit.ts';

it('[AC-B1-06i#16] POST convert 已注册并传递契约参数，完整响应通过契约校验', async () => {
  await withHttp(async (send, convert) => {
    const input = {
      ...body,
      item_ref: 'synthetic-card-reference',
      spm: 'h5.synthetic.entry',
      installed: 'false',
    };
    const response = await send(input);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0, trace_id: traceId, data });
    await validate(response.json(), 'ConvertLinkResponse');
    expect(convert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: input,
        client: 'ios',
        traceId,
        idempotencyKey: 'synthetic-http-convert',
      }),
    );
  });
}, 30_000);

it('[AC-B1-06i#17] URL 入口合法；installed 缺省按 unknown 传递', async () => {
  await withHttp(async (send, convert) => {
    const input = {
      platform: 'taobao',
      url: 'https://taobao.example.test/product/12345',
      scene: 'h5',
    };
    const response = await send(input);
    expect(response.statusCode).toBe(200);
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { ...input, installed: 'unknown' },
        client: 'ios',
      }),
    );
  });
}, 30_000);

it.each([
  { ...body, url: 'https://jd.example.test/product/12345' },
  { platform: 'jd', scene: 'h5' },
  { ...body, scene: 'share' },
  { ...body, scene: 'search' },
  { platform: 'jd', product_key: 'jd:i_12345' },
  { ...body, installed: true },
  { ...body, user_id: 'synthetic-attacker' },
  { ...body, pid: 'synthetic-attacker-pid' },
])(
  '[AC-B1-06i#18] 非法请求 %j → 20001，不进入用例',
  async (input) => {
    await withHttp(async (send, convert) => {
      const response = await send(input);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 20001 });
      await validate(response.json(), 'ErrorEnvelope');
      expect(convert).not.toHaveBeenCalled();
    });
  },
  30_000,
);

it('[AC-B1-06i#19] 未登录 10001，真实 token 检查阻止请求进入 convert', async () => {
  await withHttp(async (send, convert) => {
    const response = await send(body, { authorization: undefined });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
    expect(convert).not.toHaveBeenCalled();
  });
}, 30_000);

it('[AC-B1-06i#20] 缺失 Idempotency-Key → 20001，不进入用例', async () => {
  await withHttp(async (send, convert) => {
    const response = await send(body, { 'idempotency-key': undefined });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001 });
    expect(convert).not.toHaveBeenCalled();
  });
}, 30_000);

it('[AC-B1-06i#21] 签名缺失不得进入 convert', async () => {
  await withHttp(async (send, convert) => {
    const response = await send(body, { 'x-sign': undefined });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10401 });
    expect(convert).not.toHaveBeenCalled();
  });
}, 30_000);
