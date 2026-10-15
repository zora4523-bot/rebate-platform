import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { AliyunReviewDeps } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import {
  CONTENT,
  CREDENTIALS,
  ENDPOINT,
  SIDES,
  SIGNED_HEADERS,
  fixture,
  flush,
  requestContent,
  response,
  verdictBody,
} from './kit.ts';

for (const side of SIDES) {
  it(`[AC-B3-06b#13][BR-AI-18] ${side} 发往配置地址、禁止跳转、签名对象与实际请求相同`, async () => {
    const endpoint = 'https://alternate.example.invalid/';
    const f = fixture(side, { endpoint });
    await expect(f.port.review(CONTENT)).resolves.toBe('pass');
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe(endpoint);
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(call?.init.headers).toMatchObject(SIGNED_HEADERS);
    expect(new URLSearchParams(call?.init.body).get('Service')).toBe(
      side === 'input' ? 'llm_query_moderation' : 'llm_response_moderation',
    );
    expect(call === undefined ? undefined : requestContent(call.init)).toEqual({
      content: CONTENT,
    });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.sign.mock.calls[0]?.[0]).toMatchObject({
      endpoint,
      method: 'POST',
      body: call?.init.body,
      action: 'TextModerationPlus',
      version: '2022-03-02',
    });
    expect(f.sign.mock.calls[0]?.[1]).toEqual(CREDENTIALS);
    expect(f.sign.mock.calls[0]?.[2]).toBe(call?.init.signal);
    const unsignedHeaders = f.sign.mock.calls[0]?.[0].headers ?? {};
    expect(call?.init.headers).toMatchObject(unsignedHeaders);
    expect(
      Object.entries(call?.init.headers ?? {}).find(
        ([key]) => key.toLowerCase() === 'content-type',
      )?.[1],
    ).toContain('application/x-www-form-urlencoded');
    expect(f.credentials).toHaveBeenCalledTimes(1);
    const logs = inspect(
      Object.values(f.logger).flatMap((fn) => fn.mock.calls),
      { depth: null },
    );
    for (const secret of Object.values(CREDENTIALS)) {
      expect(logs).not.toContain(secret);
      expect(call?.url).not.toContain(secret);
      expect(call?.init.body).not.toContain(secret);
    }
    expect(logs).not.toContain(SIGNED_HEADERS.authorization);
    expect(logs).not.toContain('合成审核正文');
  });

  it(`[AC-B3-06b#14][BR-AI-18] ${side} 每次请求重新取凭据和签名，不缓存旧 Key`, async () => {
    const rotated = { ...CREDENTIALS, accessKeySecret: 'synthetic-rotated-secret' };
    const credentials = vi.fn().mockReturnValueOnce(CREDENTIALS).mockReturnValueOnce(rotated);
    const f = fixture(side, { credentials });
    await expect(f.port.review('合成请求甲')).resolves.toBe('pass');
    await expect(f.port.review('合成请求乙')).resolves.toBe('pass');
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(f.sign).toHaveBeenCalledTimes(2);
    expect(f.sign.mock.calls.map((call) => call[1])).toEqual([CREDENTIALS, rotated]);
    expect(f.calls.map((call) => requestContent(call.init))).toEqual([
      { content: '合成请求甲' },
      { content: '合成请求乙' },
    ]);
    expect(f.calls.map((call) => call.url)).toEqual([ENDPOINT, ENDPOINT]);
  });

  it.each([
    'fetch-sync',
    'fetch-reject',
    'credentials',
    'sign-sync',
    'sign-reject',
    'body-sync',
    'body-reject',
    'timeout-config',
  ] as const)(
    `[AC-B3-06b#15][BR-AI-18] ${side} %s 异常归一 timeout，错误与日志不泄露凭据和正文`,
    async (stage) => {
      const sensitive = [...Object.values(CREDENTIALS), SIGNED_HEADERS.authorization, CONTENT];
      const error = new Error(sensitive.join(' | '), { cause: { ...CREDENTIALS, body: CONTENT } });
      const fail = (): never => {
        throw error;
      };
      const overrides: { -readonly [K in keyof AliyunReviewDeps]?: AliyunReviewDeps[K] } = {};
      switch (stage) {
        case 'fetch-sync':
          overrides.fetch = fail;
          break;
        case 'fetch-reject':
          overrides.fetch = () => Promise.reject(error);
          break;
        case 'credentials':
          overrides.credentials = fail;
          break;
        case 'sign-sync':
          overrides.sign = fail;
          break;
        case 'sign-reject':
          overrides.sign = () => Promise.reject(error);
          break;
        case 'body-sync':
          overrides.fetch = () => Promise.resolve({ status: 200, text: fail });
          break;
        case 'body-reject':
          overrides.fetch = () =>
            Promise.resolve({ status: 200, text: () => Promise.reject(error) });
          break;
        case 'timeout-config':
          overrides.timeoutMs = fail;
          break;
      }
      const f = fixture(side, overrides);
      // 工厂的 NotImplemented 不捕获，不能将骨架错误误认为预期失败路径。
      let escaped: unknown;
      let result: unknown;
      try {
        result = await f.port.review(CONTENT);
      } catch (caught) {
        escaped = caught;
      }
      await flush();
      const exposed = inspect(
        { escaped, result, logs: Object.values(f.logger).flatMap((fn) => fn.mock.calls) },
        { depth: null },
      );
      for (const value of sensitive) expect(exposed).not.toContain(value);
      expect(exposed).not.toContain('合成审核正文');
      expect(escaped).toBeUndefined();
      expect(result).toBe('timeout');
      expect(f.scheduler.pending).toBe(0);
      if (stage === 'credentials' || stage.startsWith('sign') || stage === 'timeout-config') {
        expect(f.calls).toHaveLength(0);
      } else {
        expect(f.calls).toHaveLength(1);
      }
    },
  );

  it(`[AC-B3-06b#16][BR-AI-18] ${side} 响应中的原文与代答不能进入返回值或日志`, async () => {
    const f = fixture(side, {
      fetch: () =>
        Promise.resolve(
          response({
            ...(verdictBody('high') as object),
            Message: CONTENT,
            Data: {
              RiskLevel: 'high',
              Advice: [{ Answer: CONTENT }],
              Result: [{ RiskWords: CONTENT }],
            },
          }),
        ),
    });
    await expect(f.port.review(CONTENT)).resolves.toBe('block');
    expect(
      inspect(
        Object.values(f.logger).flatMap((fn) => fn.mock.calls),
        { depth: null },
      ),
    ).not.toContain('合成审核正文');
  });
}
