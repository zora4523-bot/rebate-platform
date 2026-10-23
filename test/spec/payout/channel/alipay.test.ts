import { verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  AlipayChannel,
  undiciTransport,
} from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import type { ChannelTransport } from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import { fixture, keys, REQUEST, signedEnvelope, VERIFIED_TEST_LISTS } from './fixtures.ts';

it.each([
  [1n, '0.01'],
  [100n, '1.00'],
  [1234n, '12.34'],
  [500000n, '5000.00'],
  [9007199254740993n, '90071992547409.93'],
])(
  '[AC-B2-06b#16] transfer serializes %s fen exactly as %s yuan and signs the final request',
  async (netFen, amount) => {
    const { options, send } = fixture();
    const result = await new AlipayChannel(options).transfer({ ...REQUEST, netFen });
    expect(result).toMatchObject({
      kind: 'success',
      raw: { code: '10000' },
      channelOrderId: 'test_order',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(options.credentials.gatewayUrl);
    expect(init.method).toBe('POST');
    expect(
      Object.entries(init.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1],
    ).toContain('application/x-www-form-urlencoded');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = new URLSearchParams(init.body);
    expect(form.get('method')).toBe('alipay.fund.trans.uni.transfer');
    expect(form.get('app_id')).toBe('test_app_id');
    expect(form.get('sign_type')).toBe('RSA2');
    expect(form.get('timestamp')).toBe('2026-10-23 12:34:56');
    expect(JSON.parse(form.get('biz_content')!)).toMatchObject({
      out_biz_no: REQUEST.outBizNo,
      trans_amount: amount,
      product_code: 'TRANS_ACCOUNT_NO_PWD',
      biz_scene: 'DIRECT_TRANSFER',
      order_title: options.bizScene,
      transfer_scene: options.bizScene,
      payee_info: {
        identity_type: 'ALIPAY_LOGON_ID',
        identity: REQUEST.payee.identity,
        name: REQUEST.payee.name,
      },
    });
    // Independent oracle: never use the production canonicalizer or signer to check its own output.
    const canonical = [...form.entries()]
      .filter(([key]) => key !== 'sign')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(canonical),
        keys().publicKey,
        Buffer.from(form.get('sign')!, 'base64'),
      ),
    ).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
  },
);

it('[AC-B2-06b#17] query sends the original outBizNo plus product and scene and uses query status', async () => {
  const { options, send } = fixture(async () => ({
    status: 200,
    body: signedEnvelope(
      'query',
      '{"code":"10000","status":"SUCCESS","order_id":"query_order","pay_date":"2026-10-23 12:30:00"}',
    ),
  }));
  const result = await new AlipayChannel(options).query(REQUEST.outBizNo);
  expect(result).toMatchObject({
    kind: 'success',
    raw: { code: '10000' },
    channelOrderId: 'query_order',
  });
  expect(Date.parse(result.paidAt!)).toBe(Date.parse('2026-10-23T12:30:00+08:00'));
  expect(send).toHaveBeenCalledTimes(1);
  const form = new URLSearchParams(send.mock.calls[0]![1].body);
  expect(form.get('method')).toBe('alipay.fund.trans.common.query');
  expect(JSON.parse(form.get('biz_content')!)).toMatchObject({
    out_biz_no: REQUEST.outBizNo,
    product_code: 'TRANS_ACCOUNT_NO_PWD',
    biz_scene: 'DIRECT_TRANSFER',
  });
});

it.each([
  ['TEST_CONFIRMED_FAIL', 'fail', false],
  ['TEST_PAYER_SIDE', 'payer_side', true],
  ['TEST_UNRECOGNIZED', 'unknown', true],
] as const)(
  '[AC-B2-06b#18] signed business response %s retains evidence and normalizes to %s',
  async (subCode, kind, pause) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope(
        'transfer',
        JSON.stringify({
          code: '40004',
          sub_code: subCode,
          msg: 'synthetic business error',
        }),
      ),
    }));
    options.lists = VERIFIED_TEST_LISTS;
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe(kind);
    expect(result.pauseQueue === true).toBe(pause);
    expect(result.raw).toEqual({ code: '40004', subCode, msg: 'synthetic business error' });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each(['PAYEE_NOT_EXIST', 'PAYER_BALANCE_NOT_ENOUGH', 'EXCEED_LIMIT_DM_AMOUNT'])(
  '[AC-B2-06b#19] default Alipay adapter does not hardcode sample error %s',
  async (subCode) => {
    const { options } = fixture(async () => ({
      status: 200,
      body: signedEnvelope(
        'transfer',
        JSON.stringify({
          code: '40004',
          sub_code: subCode,
        }),
      ),
    }));
    expect(await new AlipayChannel(options).transfer(REQUEST)).toMatchObject({
      kind: 'unknown',
      pauseQueue: true,
    });
  },
);

it.each(['FAIL', 'PROCESSING', 'ORDER_NOT_EXIST'])(
  '[AC-B2-06b#20] query HTTP/business success with unverified status %s remains unknown',
  async (status) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope('query', JSON.stringify({ code: '10000', status })),
    }));
    expect((await new AlipayChannel(options).query(REQUEST.outBizNo)).kind).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#21] query honors a configured failure mapping separately from synchronous lists', async () => {
  const { options } = fixture(async () => ({
    status: 200,
    body: signedEnvelope('query', '{"code":"10000","status":"TEST_FINAL_FAIL"}'),
  }));
  options.lists = VERIFIED_TEST_LISTS;
  expect((await new AlipayChannel(options).query(REQUEST.outBizNo)).kind).toBe('fail');
});

it.each(['transfer', 'query'] as const)(
  '[AC-B2-06b#22] %s rejects unverified success and retains unknown',
  async (method) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope(
        method,
        '{"code":"10000","status":"SUCCESS"}',
        Buffer.from('invalid signature').toString('base64'),
      ),
    }));
    const channel = new AlipayChannel(options);
    const result = await (method === 'transfer'
      ? channel.transfer(REQUEST)
      : channel.query(REQUEST.outBizNo));
    expect(result.kind).toBe('unknown');
    expect(result.paidAt).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#23] valid response signature verifies original nested node text, not JSON reserialization', async () => {
  const node =
    '{ "code" : "10000", "msg" : "a } brace and \\" quote", "order_id":"raw_order", "extra":{"nested":"value"} }';
  const { options } = fixture(async () => ({
    status: 200,
    body: signedEnvelope('transfer', node),
  }));
  expect(await new AlipayChannel(options).transfer(REQUEST)).toMatchObject({
    kind: 'success',
    channelOrderId: 'raw_order',
  });
});

it.each([
  { label: 'HTTP 500', status: 500 },
  { label: 'HTTP 503', status: 503 },
])(
  '[AC-B2-06b#24] $label is transport unknown even if its body claims a signed success',
  async ({ status }) => {
    const { options, send } = fixture(async () => ({
      status,
      body: signedEnvelope('transfer', '{"code":"10000"}'),
    }));
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each(['ECONNRESET', 'ETIMEDOUT'])(
  '[AC-B2-06b#25] transport rejection %s is unknown without queue pause or retry',
  async (code) => {
    const { options, send } = fixture(async () => {
      throw Object.assign(new Error('synthetic network error'), { code });
    });
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#26] SYSTEM_ERROR remains unknown and never retries transfer', async () => {
  const { options, send } = fixture(async () => ({
    status: 200,
    body: signedEnvelope('transfer', '{"code":"20000","sub_code":"SYSTEM_ERROR"}'),
  }));
  expect((await new AlipayChannel(options).transfer(REQUEST)).kind).toBe('unknown');
  expect(send).toHaveBeenCalledTimes(1);
});

it('[AC-B2-06b#27] transfer aborts at 10000 ms, not before, without retry or queue pause', async () => {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout does not use JS fake timers: adapt that primitive only.
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('test deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
  try {
    let signal: AbortSignal | undefined;
    const { options, send } = fixture(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    );
    const channel = new AlipayChannel(options);
    let settled = false;
    const pending = channel.transfer(REQUEST).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ kind: 'unknown' });
    expect((await pending).pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

it.each(['', '{broken', '{"alipay_fund_trans_uni_transfer_response":{"code":"10000"}}'])(
  '[AC-B2-06b#28] malformed or unsigned response is unknown: %s',
  async (body) => {
    const { options, send } = fixture(async () => ({ status: 200, body }));
    expect((await new AlipayChannel(options).transfer(REQUEST)).kind).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#29] provider paid time wins; absent time falls back to response receipt Clock', async () => {
  const first = fixture(async () => ({
    status: 200,
    body: signedEnvelope('transfer', '{"code":"10000","trans_date":"2026-10-23 11:22:33"}'),
  }));
  const provider = await new AlipayChannel(first.options).transfer(REQUEST);
  expect(Date.parse(provider.paidAt!)).toBe(Date.parse('2026-10-23T11:22:33+08:00'));
  const fallback = fixture();
  fallback.send.mockImplementation(async () => {
    fallback.clock.advanceMs(2500);
    return { status: 200, body: signedEnvelope('transfer', '{"code":"10000"}') };
  });
  const received = await new AlipayChannel(fallback.options).transfer(REQUEST);
  expect(Date.parse(received.paidAt!)).toBe(fallback.clock.now().getTime());
});

it.each(['privateKey', 'alipayPublicKey', 'appId', 'gatewayUrl', 'bizScene'] as const)(
  '[AC-B2-06b#30] missing %s fails closed before any transport call',
  async (field) => {
    const { options, send } = fixture();
    if (field === 'bizScene') options.bizScene = '';
    else options.credentials[field] = '';
    // Exact configuration rejection must not accept a generic NotImplemented error as a pass.
    await expect(
      Promise.resolve().then(() => new AlipayChannel(options).transfer(REQUEST)),
    ).rejects.toMatchObject({ code: 'PAYOUT_CHANNEL_NOT_CONFIGURED' });
    expect(send).not.toHaveBeenCalled();
  },
);

it('[AC-B2-06b#31] pino output retains operation evidence without plaintext account/name or credentials', async () => {
  const output: string[] = [];
  const { options } = fixture();
  options.logger = createRootLogger(
    { level: 'info', entry: 'payout', appEnv: 'test' },
    {
      write: (chunk: string) => {
        output.push(chunk);
      },
    },
  );
  const result = await new AlipayChannel(options).transfer(REQUEST);
  expect(result.kind).toBe('success');
  const text = output.join('');
  expect(output.length).toBeGreaterThan(0);
  expect(text).toContain(REQUEST.outBizNo);
  expect(text).toContain('10000');
  for (const secret of [
    REQUEST.payee.identity,
    REQUEST.payee.name,
    'BEGIN PRIVATE KEY',
    keys().privateKey.split('\n')[1]!,
  ]) {
    expect(text).not.toContain(secret);
  }
});

it('[AC-B2-06b#32] transport error text containing payee data never leaks into logs', async () => {
  const output: string[] = [];
  const transport: ChannelTransport = async () => {
    throw new Error(`${REQUEST.payee.identity} ${REQUEST.payee.name}`);
  };
  const { options } = fixture(transport);
  options.logger = createRootLogger(
    { level: 'info', entry: 'payout', appEnv: 'test' },
    {
      write: (line: string) => {
        output.push(line);
      },
    },
  );
  expect((await new AlipayChannel(options).transfer(REQUEST)).kind).toBe('unknown');
  expect(output.length).toBeGreaterThan(0);
  expect(output.join('')).not.toContain(REQUEST.payee.identity);
  expect(output.join('')).not.toContain(REQUEST.payee.name);
});

it('[AC-B2-06b#39] default transport delegates to built-in undici fetch with the supplied abort signal', async () => {
  const signal = new AbortController().signal;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('synthetic body', { status: 503 }));
  try {
    const options = {
      method: 'POST' as const,
      body: 'test=value',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal,
    };
    expect(await undiciTransport('https://alipay.test.invalid/gateway.do', options)).toStrictEqual({
      status: 503,
      body: 'synthetic body',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://alipay.test.invalid/gateway.do',
      expect.objectContaining(options),
    );
  } finally {
    fetchMock.mockRestore();
  }
});

it('[AC-B2-06b#40] tampered failure response cannot trigger a refund or payer-side decision', async () => {
  const { options } = fixture(async () => ({
    status: 200,
    body: signedEnvelope(
      'transfer',
      '{"code":"40004","sub_code":"TEST_CONFIRMED_FAIL"}',
      'invalid',
    ),
  }));
  options.lists = VERIFIED_TEST_LISTS;
  expect((await new AlipayChannel(options).transfer(REQUEST)).kind).toBe('unknown');
});

it('[AC-B2-06b#41] query after unknown sends only a query, never a second transfer', async () => {
  const { options, send } = fixture();
  send.mockRejectedValueOnce(new Error('connection lost'));
  send.mockResolvedValueOnce({
    status: 200,
    body: signedEnvelope('query', '{"code":"10000","status":"SUCCESS"}'),
  });
  const channel = new AlipayChannel(options);
  expect((await channel.transfer(REQUEST)).kind).toBe('unknown');
  expect((await channel.query(REQUEST.outBizNo)).kind).toBe('success');
  expect(
    send.mock.calls.map(([, init]) => new URLSearchParams(init.body).get('method')),
  ).toStrictEqual(['alipay.fund.trans.uni.transfer', 'alipay.fund.trans.common.query']);
});
