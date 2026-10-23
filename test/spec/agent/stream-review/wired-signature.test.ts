import { createHash, createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { input } from '../orchestrator-core/kit.ts';
import { credentials, endpoint, fixture, requestContent } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

// Independent oracle for the requests actually sent by the assembly, not signer unit calls.
// Aliyun V3 steps: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

it.each(['staging', 'prod'] as const)(
  '[AC-B3-03m#20] %s 装配发出的输入/输出请求逐一通过独立 ACS3 签名核对',
  async (appEnv) => {
    const f = fixture(['none'], { appEnv });
    const ports = f.build();
    expect(f.calls).toEqual([]);
    expect(await ports.inputCheck.check(input(), new AbortController().signal)).toMatchObject({
      kind: 'proceed',
      modelText: '合成保温杯',
    });
    await f.time.to(1_234);
    expect(await ports.review.review('合成输出。')).toBe('pass');
    expect(f.calls.map(({ init }) => requestContent(init))).toEqual([
      { service: 'llm_query_moderation', content: '合成保温杯' },
      { service: 'llm_response_moderation', content: '合成输出。' },
    ]);

    for (const [index, call] of f.calls.entries()) {
      expect(call.url).toBe(endpoint);
      expect(call.init).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = Object.fromEntries(
        Object.entries(call.init.headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      const expectedTime = new Date(f.time.clock.now().getTime() - (index === 0 ? 1_234 : 0))
        .toISOString()
        .replace(/\.\d{3}Z$/u, 'Z');
      expect(headers).toMatchObject({
        host: new URL(endpoint).host,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        'x-acs-action': 'TextModerationPlus',
        'x-acs-version': '2022-03-02',
        'x-acs-date': expectedTime,
        'x-acs-signature-nonce': `synthetic-nonce-${index + 1}`,
        'x-acs-content-sha256': sha256(call.init.body),
      });
      // Derive the complete set from the wire headers, never trust SignedHeaders supplied by
      // the SUT. Omitting a required header or omitting it from the signature must both fail.
      const names = Object.keys(headers)
        .filter((name) => name === 'host' || name === 'content-type' || name.startsWith('x-acs-'))
        .sort();
      const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
      const canonical = [
        'POST',
        '/',
        '',
        canonicalHeaders,
        names.join(';'),
        sha256(call.init.body),
      ].join('\n');
      const signature = createHmac('sha256', credentials.accessKeySecret)
        .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`, 'utf8')
        .digest('hex');
      expect(headers['authorization']).toBe(
        `ACS3-HMAC-SHA256 Credential=${credentials.accessKeyId},SignedHeaders=${names.join(';')},Signature=${signature}`,
      );
      expect(f.logs.lines.join('\n')).not.toContain(signature);
    }
    expect(f.logs.lines.join('\n')).not.toContain(credentials.accessKeySecret);
    expect(f.unexpectedFetch).not.toHaveBeenCalled();
  },
);
