import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { createHttpApp } from '../../../bootstrap.ts';
import { loadConfig } from '../config/index.ts';
import { createRootLogger, PinoNestLogger, REDACTED } from './index.ts';

function capture() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'api', appEnv: 'test' },
    { write: (line: string) => lines.push(line) },
  );
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

it('[AC-B1-01c#1] serializes callable toJSON results before redaction and omits other functions', () => {
  const { logger, records } = capture();
  const deferred = Object.assign(() => undefined, {
    toJSON: () => ({ phone: '13987654321', message: '手机号13987654321' }),
  });
  logger.info({ payload: { deferred, omitted: () => undefined } }, 'event');
  expect(records()[0]).toMatchObject({
    payload: { deferred: { phone: REDACTED, message: `手机号${REDACTED}` } },
  });
  expect(records()[0]?.['payload'] as object).not.toHaveProperty('omitted');
  expect(deferred.toJSON()).toEqual({ phone: '13987654321', message: '手机号13987654321' });
});

it('[AC-B1-01c#2] child serializers cannot bypass final msg or structured redaction at any generation', () => {
  const { logger, lines, records } = capture();
  const serializer = vi.fn((value: unknown) => ({ phone: '13987654321', original: value }));
  const child = logger.child(
    {},
    {
      serializers: { msg: (value: unknown) => String(value).trim(), payload: serializer },
    },
  );
  child.info(' 手机号13987654321 ');
  const grandchild = child.child({ payload: { real_name: '张三' } });
  grandchild.setBindings({ extra: { phone: '13987654321' } });
  grandchild.info({ payload: { real_name: '李四' } }, '手机号%s', '13987654321');
  child
    .child(
      {},
      {
        serializers: { msg: () => ({ phone: '13987654321', text: '手机号13987654321' }) },
        msgPrefix: '手机号13987654321 ',
      },
    )
    .info('event');
  expect(records()[0]?.['msg']).toBe(`手机号${REDACTED}`);
  expect(records()[1]).toMatchObject({
    payload: { phone: REDACTED, original: { real_name: REDACTED } },
    extra: { phone: REDACTED },
    msg: `手机号${REDACTED}`,
  });
  expect(records()[2]?.['msg']).toBe(`{"phone":"${REDACTED}","text":"手机号${REDACTED}"}`);
  expect(serializer).toHaveBeenCalledTimes(2);
  expect(lines.join('')).not.toMatch(/13987654321|张三|李四/);
});

it('[AC-B1-01c#3] bigint messages are scrubbed and structured bigint stays numeric without losing lines', () => {
  const { logger, lines, records } = capture();
  logger.info(13987654321n);
  logger.info({ message: 13987654321n, r: { stack: 13987654321n }, amount_fen: 123n });
  logger.info({ order_id: 123456789012345678901234567890n });
  new PinoNestLogger(logger).log({ amount_fen: 123n });
  expect(records()).toHaveLength(4);
  expect(records()[0]?.['msg']).toBe(REDACTED);
  expect(records()[1]).toMatchObject({
    message: REDACTED,
    r: { stack: REDACTED },
    amount_fen: 123,
  });
  expect(lines[2]).toContain('"order_id":123456789012345678901234567890');
  expect(records()[3]?.['msg']).toBe('{"amount_fen":123}');
});

it('[AC-B1-01c#4] free-text context follows arrays and objects and nonprimitive msg becomes safe JSON', () => {
  const { logger, records, lines } = capture();
  const values = ['手机号13987654321', 13987654321, 13987654321n, [{ text: '13987654321' }]];
  // Pino accepts these at runtime although its declaration only admits string messages.
  const logMessage = logger.info.bind(logger) as (fields: object, message: unknown) => void;
  logMessage({ order_id: 'o1' }, ['手机号13987654321']);
  logger.info(
    { r: { stack: values }, message: { nested: values }, kept: { id: 13987654321 } },
    'x',
  );
  logMessage({}, { text: '13987654321', phone: '13987654321' });
  expect(records()[0]?.['msg']).toBe(`["手机号${REDACTED}"]`);
  const scrubbed = [`手机号${REDACTED}`, REDACTED, REDACTED, [{ text: REDACTED }]];
  expect(records()[1]).toMatchObject({
    r: { stack: scrubbed },
    message: { nested: scrubbed },
    kept: { id: 13987654321 },
  });
  expect(records()[2]?.['msg']).toBe(`{"text":"${REDACTED}","phone":"${REDACTED}"}`);
  expect(lines[0]).not.toContain('13987654321');
  expect(values[0]).toBe('手机号13987654321');
});

it('[AC-B1-01c#5] Fastify inject keeps access-log request and response fields without listening', async () => {
  const { logger, records } = capture();
  const app = await createHttpApp('api', { logger, config: loadConfig({ APP_ENV: 'test' }) });
  try {
    await app.init();
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: '127.0.0.2',
    });
    expect(response.statusCode).toBe(200);
    expect(app.getHttpServer().listening).toBe(false);
    expect(records().find((record) => record['msg'] === 'incoming request')?.['req']).toMatchObject(
      {
        method: 'GET',
        url: '/healthz',
        hostname: 'localhost',
        remoteAddress: '127.0.0.2',
      },
    );
    expect(
      records().find((record) => record['msg'] === 'request completed')?.['res'],
    ).toMatchObject({ statusCode: 200 });
  } finally {
    await app.close();
  }
  // inject has no TCP remotePort. Verify it separately with prototype getters like Request's.
  class Request {
    raw = {};
    get method() {
      return 'GET';
    }
    get url() {
      return '/healthz';
    }
    get hostname() {
      return 'localhost';
    }
    get ip() {
      return '127.0.0.2';
    }
    get socket() {
      return { remotePort: 43210 };
    }
  }
  logger.info({ req: new Request() }, 'socket fields');
  expect(records().at(-1)?.['req']).toEqual({
    method: 'GET',
    url: '/healthz',
    hostname: 'localhost',
    remoteAddress: '127.0.0.2',
    remotePort: 43210,
  });
});

it('[AC-B1-01c#6] logs an 80000-character non-email in less than one second', () => {
  const { logger, records } = capture();
  const message = 'a'.repeat(80_000);
  const started = performance.now();
  logger.error(message);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(1000);
  expect(records()[0]?.['msg']).toBe(message);
});

it('[AC-B1-01c#7] printf %s preserves Error and custom toString text then scrubs the final message', () => {
  const { logger, records } = capture();
  const error = new TypeError('手机号13987654321');
  logger.error(
    'payout failed: %s; %% %s; %j',
    error,
    {
      toString: () => '电话13987654321',
    },
    { phone: '13987654321' },
  );
  expect(records()[0]?.['msg']).toBe(
    `payout failed: TypeError: 手机号${REDACTED}; % 电话${REDACTED}; {"phone":"${REDACTED}"}`,
  );
  expect(error.message).toBe('手机号13987654321');
});

it('[AC-B1-01c#8] throwing getters/toJSON and 3000-level objects produce safe placeholders without throwing', () => {
  const { logger, lines, records } = capture();
  const fail = () => {
    throw new Error('13987654321');
  };
  const value = {
    get broken() {
      return fail();
    },
    get phone() {
      return fail();
    },
    nested: {
      get broken() {
        return fail();
      },
      kept: 'yes',
    },
    badJSON: { toJSON: fail },
    badJSONGetter: {
      get toJSON() {
        return fail();
      },
    },
    badFunction: Object.assign(() => undefined, { toJSON: fail }),
  };
  let deep: unknown = { phone: '13987654321' };
  for (let index = 0; index < 3000; index++) deep = { nested: deep };
  expect(() => logger.info(value, 'event')).not.toThrow();
  expect(() => logger.info({ deep }, 'deep')).not.toThrow();
  expect(() => logger.child(value).info('bound')).not.toThrow();
  expect(() =>
    logger.child({}, { serializers: { custom: fail } }).info({ custom: value }),
  ).not.toThrow();
  expect(records()[0]).toMatchObject({
    broken: '[Unserializable]',
    phone: REDACTED,
    nested: { broken: '[Unserializable]', kept: 'yes' },
    badJSON: '[Unserializable]',
    badJSONGetter: '[Unserializable]',
    badFunction: '[Unserializable]',
  });
  expect(records()[3]?.['custom']).toBe('[Unserializable]');
  expect(lines[1]).toContain('[Truncated]');
  expect(lines.join('')).not.toContain('13987654321');
  expect(lines).toHaveLength(4);
});

it('[AC-B1-01c#9] ID matching leaves a separator and trailing X untouched', () => {
  const { logger, records } = capture();
  logger.info('证件 11010519491231002 X 待核验');
  logger.info('证件 11010519491231002-X 待核验');
  logger.info('证件 110105 19491231 002X 待核验');
  expect(records().map((record) => record['msg'])).toEqual([
    `证件 ${REDACTED} X 待核验`,
    `证件 ${REDACTED}-X 待核验`,
    `证件 ${REDACTED} 待核验`,
  ]);
});
