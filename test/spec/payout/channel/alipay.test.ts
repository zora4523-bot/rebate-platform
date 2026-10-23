import { verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  PayoutChannelNotConfiguredError,
  PayoutPayeeNameRequiredError,
} from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import {
  AlipayChannel,
  undiciTransport,
} from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import type { ChannelTransport } from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import {
  alipayKeys,
  appKeys,
  fakeAbortTimeout,
  fixture,
  LOGON_ID,
  MASKED_LOGON_ID,
  REQUEST,
  signedEnvelope,
  signNode,
  TIMEOUT_MS,
  VERIFIED_TEST_LISTS,
} from './fixtures.ts';

// ISO-8601 local time written with the explicit +08:00 offset (milliseconds optional).
const ISO_PLUS_8 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?\+08:00$/;

function captureLogs() {
  const output: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'payout', appEnv: 'test' },
    {
      write: (chunk: string) => {
        output.push(chunk);
      },
    },
  );
  const records = () =>
    output
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { output, logger, records };
}

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
    const bizContent = form.get('biz_content')!;
    const biz = JSON.parse(bizContent) as Record<string, unknown>;
    expect(biz).toMatchObject({
      out_biz_no: REQUEST.outBizNo,
      trans_amount: amount,
      product_code: 'TRANS_ACCOUNT_NO_PWD',
      biz_scene: 'DIRECT_TRANSFER',
      payee_info: {
        identity_type: 'ALIPAY_LOGON_ID',
        identity: REQUEST.payee.identity,
        name: REQUEST.payee.name,
      },
    });
    expect(typeof biz['order_title']).toBe('string');
    expect(biz['order_title']).not.toBe('');
    // The transfer-scene field name is not fixed by the spec: only the configured value is.
    expect(bizContent).toContain(options.bizScene);
    // Independent oracle: never use the production canonicalizer or signer to check its own output.
    const canonical = [...form.entries()]
      .filter(([key, value]) => key !== 'sign' && value !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const signature = Buffer.from(form.get('sign')!, 'base64');
    expect(verify('RSA-SHA256', Buffer.from(canonical), appKeys().publicKey, signature)).toBe(true);
    // Requests are signed with the application key, never with anything on the Alipay side.
    expect(verify('RSA-SHA256', Buffer.from(canonical), alipayKeys().publicKey, signature)).toBe(
      false,
    );
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
  expect(result.paidAt).toMatch(ISO_PLUS_8);
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
    // Signature failure is transport-class: unknown without pausing the queue.
    expect('pauseQueue' in result && result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#23] valid response signature verifies original nested node text, not JSON reserialization', async () => {
  const node =
    '{ "code" : "10000", "status":"SUCCESS", "msg" : "a } brace and \\" quote", "order_id":"raw_order", "extra":{"nested":"value"} }';
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
      body: signedEnvelope('transfer', '{"code":"10000","status":"SUCCESS"}'),
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

it.each([
  ['20000', 'SYSTEM_ERROR'],
  ['20000', 'isp.unknow-error'],
  ['40004', 'SYSTEM_ERROR'],
  ['40004', 'TEST_UNRECOGNIZED'],
])(
  '[AC-B2-06b#26] signed business code %s/%s is unknown, pauses the queue, and never retries transfer',
  async (code, subCode) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope('transfer', JSON.stringify({ code, sub_code: subCode })),
    }));
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue).toBe(true);
    expect(result.raw).toMatchObject({ code, subCode });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {
    label: 'network error',
    transport: (async () => {
      throw new Error('synthetic network error');
    }) as ChannelTransport,
  },
  {
    label: 'HTTP 502',
    transport: (async () => ({
      status: 502,
      body: signedEnvelope('transfer', '{"code":"20000","sub_code":"SYSTEM_ERROR"}'),
    })) as ChannelTransport,
  },
  {
    label: 'unparseable body',
    transport: (async () => ({ status: 200, body: '<html>gateway</html>' })) as ChannelTransport,
  },
  {
    label: 'bad signature',
    transport: (async () => ({
      status: 200,
      body: signedEnvelope('transfer', '{"code":"20000","sub_code":"SYSTEM_ERROR"}', 'invalid'),
    })) as ChannelTransport,
  },
])(
  '[AC-B2-06b#26] transport-class $label is unknown without queue pause or retry',
  async ({ transport }) => {
    const { options, send } = fixture(transport);
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

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
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B2-06b#29] provider paid time wins; absent time falls back to response receipt Clock, both at +08:00', async () => {
  const first = fixture(async () => ({
    status: 200,
    body: signedEnvelope(
      'transfer',
      '{"code":"10000","status":"SUCCESS","trans_date":"2026-10-23 11:22:33"}',
    ),
  }));
  const provider = await new AlipayChannel(first.options).transfer(REQUEST);
  expect(provider.kind).toBe('success');
  expect(provider.paidAt).toMatch(ISO_PLUS_8);
  expect(provider.paidAt!.startsWith('2026-10-23T11:22:33')).toBe(true);
  expect(Date.parse(provider.paidAt!)).toBe(Date.parse('2026-10-23T11:22:33+08:00'));
  const fallback = fixture();
  fallback.send.mockImplementation(async () => {
    fallback.clock.advanceMs(2500);
    return {
      status: 200,
      body: signedEnvelope('transfer', '{"code":"10000","status":"SUCCESS"}'),
    };
  });
  const received = await new AlipayChannel(fallback.options).transfer(REQUEST);
  expect(received.kind).toBe('success');
  expect(received.paidAt).toMatch(ISO_PLUS_8);
  expect(received.paidAt!.startsWith('2026-10-23T12:34:58')).toBe(true);
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
    ).rejects.toBeInstanceOf(PayoutChannelNotConfiguredError);
    expect(send).not.toHaveBeenCalled();
  },
);

it.each([
  {
    label: 'success',
    node: '{"code":"10000","status":"SUCCESS","order_id":"test_order"}',
    code: '10000',
    subCode: undefined,
  },
  {
    label: 'business error',
    node: '{"code":"40004","sub_code":"TEST_UNRECOGNIZED","msg":"synthetic"}',
    code: '40004',
    subCode: 'TEST_UNRECOGNIZED',
  },
])(
  '[AC-B2-06b#31] pino output for $label keeps out_biz_no/code/sub_code/latency_ms and only the masked logon id',
  async ({ node, code, subCode }) => {
    const { options } = fixture(async () => ({
      status: 200,
      body: signedEnvelope('transfer', node),
    }));
    const logs = captureLogs();
    options.logger = logs.logger;
    await new AlipayChannel(options).transfer(REQUEST);
    const text = logs.output.join('');
    expect(logs.output.length).toBeGreaterThan(0);
    expect(text).toContain(MASKED_LOGON_ID);
    expect(
      logs
        .records()
        .some(
          (record) =>
            record['out_biz_no'] === REQUEST.outBizNo &&
            record['code'] === code &&
            (subCode === undefined || record['sub_code'] === subCode) &&
            typeof record['latency_ms'] === 'number',
        ),
    ).toBe(true);
    for (const secret of [
      LOGON_ID,
      REQUEST.payee.name,
      'BEGIN PRIVATE KEY',
      appKeys().privateKey.split('\n')[1]!,
    ]) {
      expect(text).not.toContain(secret);
    }
  },
);

it('[AC-B2-06b#32] transport error text containing payee data never leaks into logs', async () => {
  const transport: ChannelTransport = async () => {
    throw new Error(`${REQUEST.payee.identity} ${REQUEST.payee.name}`);
  };
  const { options } = fixture(transport);
  const logs = captureLogs();
  options.logger = logs.logger;
  expect((await new AlipayChannel(options).transfer(REQUEST)).kind).toBe('unknown');
  expect(logs.output.length).toBeGreaterThan(0);
  expect(logs.output.join('')).not.toContain(REQUEST.payee.identity);
  expect(logs.output.join('')).not.toContain(REQUEST.payee.name);
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

it.each([
  ['transfer', '{"code":"10000","status":"SUCCESS","order_id":"forged"}'],
  ['transfer', '{"code":"40004","sub_code":"TEST_CONFIRMED_FAIL"}'],
  ['query', '{"code":"10000","status":"SUCCESS","order_id":"forged"}'],
  ['query', '{"code":"10000","status":"TEST_FINAL_FAIL"}'],
] as const)(
  '[AC-B2-06b#42] %s response signed with the application private key fails verification -> unknown: %s',
  async (method, node) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope(method, node, signNode(node, appKeys().privateKey)),
    }));
    options.lists = VERIFIED_TEST_LISTS;
    const channel = new AlipayChannel(options);
    const result = await (method === 'transfer'
      ? channel.transfer(REQUEST)
      : channel.query(REQUEST.outBizNo));
    expect(result.kind).toBe('unknown');
    expect(result.paidAt).toBeUndefined();
    expect('pauseQueue' in result && result.pauseQueue === true).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['missing status', '{"code":"10000","order_id":"test_order"}'],
  ['DEALING', '{"code":"10000","status":"DEALING","order_id":"test_order"}'],
  ['FAIL', '{"code":"10000","status":"FAIL","order_id":"test_order"}'],
  ['lower-case success', '{"code":"10000","status":"success","order_id":"test_order"}'],
])(
  '[AC-B2-06b#43] signed transfer 10000 with %s is unknown without queue pause',
  async (_label, node) => {
    const { options, send } = fixture(async () => ({
      status: 200,
      body: signedEnvelope('transfer', node),
    }));
    const result = await new AlipayChannel(options).transfer(REQUEST);
    expect(result.kind).toBe('unknown');
    expect(result.pauseQueue === true).toBe(false);
    expect(result.paidAt).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  {
    label: 'HTTP 500',
    transport: (async () => ({
      status: 500,
      body: signedEnvelope('query', '{"code":"10000","status":"SUCCESS"}'),
    })) as ChannelTransport,
  },
  {
    label: 'HTTP 503',
    transport: (async () => ({
      status: 503,
      body: signedEnvelope('query', '{"code":"10000","status":"TEST_FINAL_FAIL"}'),
    })) as ChannelTransport,
  },
  {
    label: 'network error',
    transport: (async () => {
      throw Object.assign(new Error('synthetic network error'), { code: 'ECONNRESET' });
    }) as ChannelTransport,
  },
])('[AC-B2-06b#44] query $label is unknown and sent once', async ({ transport }) => {
  const { options, send } = fixture(transport);
  options.lists = VERIFIED_TEST_LISTS;
  const result = await new AlipayChannel(options).query(REQUEST.outBizNo);
  expect(result.kind).toBe('unknown');
  expect(result.paidAt).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});

it('[AC-B2-06b#44] query aborts at 10000 ms, not before, and is unknown', async () => {
  const restore = fakeAbortTimeout();
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
    let settled = false;
    const pending = new AlipayChannel(options).query(REQUEST.outBizNo).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(settled).toBe(true);
    expect((await pending).kind).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    restore();
  }
});

it.each(['transfer', 'query'] as const)(
  '[AC-B2-06b#45] %s never falls back to environment variables when injected credentials are empty',
  async (method) => {
    vi.stubEnv('ALIPAY_APP_ID', 'env_app_id');
    vi.stubEnv('ALIPAY_APP_PRIVATE_KEY', appKeys().privateKey);
    vi.stubEnv('ALIPAY_PUBLIC_KEY', alipayKeys().publicKey);
    vi.stubEnv('ALIPAY_GATEWAY_URL', 'https://alipay.test.invalid/gateway.do');
    try {
      const { options, send } = fixture();
      options.credentials = { appId: '', privateKey: '', alipayPublicKey: '', gatewayUrl: '' };
      await expect(
        Promise.resolve().then(() => {
          const channel = new AlipayChannel(options);
          return method === 'transfer'
            ? channel.transfer(REQUEST)
            : channel.query(REQUEST.outBizNo);
        }),
      ).rejects.toBeInstanceOf(PayoutChannelNotConfiguredError);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(['', '   ', '\t\n', '　'])(
  '[AC-B2-06b#46] payee name %j is required before any transport call',
  async (name) => {
    const { options, send } = fixture();
    await expect(
      Promise.resolve().then(() =>
        new AlipayChannel(options).transfer({
          ...REQUEST,
          payee: { identity: REQUEST.payee.identity, name },
        }),
      ),
    ).rejects.toBeInstanceOf(PayoutPayeeNameRequiredError);
    expect(send).not.toHaveBeenCalled();
  },
);
