import { describe, expect, it } from 'vitest';
import { PinoNestLogger, REDACTED, createRootLogger } from './index.ts';

function capture(level: 'info' | 'warn' | 'trace' = 'info') {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level, entry: 'api', appEnv: 'test' },
    { write: (chunk: string) => lines.push(chunk) },
  );
  const records = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('createRootLogger', () => {
  it('writes one JSON line per record with entry, env, pid and an ISO timestamp', () => {
    const { logger, lines, records } = capture();
    logger.info({ listening: false }, 'started');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(records()[0]).toMatchObject({
      level: 30,
      entry: 'api',
      env: 'test',
      pid: process.pid,
      listening: false,
      msg: 'started',
    });
    expect(records()[0]?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('filters records below the configured level', () => {
    const { logger, records } = capture('warn');
    logger.info('dropped');
    logger.debug('dropped');
    logger.warn('kept');
    logger.error('kept too');
    expect(records().map((record) => record['msg'])).toEqual(['kept', 'kept too']);
  });

  it('redacts sensitive keys at the top level and one level down', () => {
    const { logger, lines, records } = capture();
    logger.info(
      {
        password: 'p1',
        token: 't1',
        secret: 's1',
        phone: '13800000000',
        id_no: '110101199001011234',
        user: {
          phone: '13900000000',
          id_no: 'X',
          access_token: 'a',
          refresh_token: 'r',
          name: 'ok',
        },
        body: { password: 'p2', step_up_token: 'st', authorization: 'Bearer zzz', amount_fen: 100 },
      },
      'sensitive',
    );
    expect(records()[0]).toMatchObject({
      password: REDACTED,
      token: REDACTED,
      secret: REDACTED,
      phone: REDACTED,
      id_no: REDACTED,
      user: {
        phone: REDACTED,
        id_no: REDACTED,
        access_token: REDACTED,
        refresh_token: REDACTED,
        name: 'ok',
      },
      body: {
        password: REDACTED,
        step_up_token: REDACTED,
        authorization: REDACTED,
        amount_fen: 100,
      },
    });
    expect(lines[0]).not.toMatch(/p1|t1|s1|13800000000|13900000000|110101199001011234|Bearer zzz/);
  });

  it('redacts credential headers in request and response shapes', () => {
    const { logger, lines, records } = capture();
    logger.info(
      {
        req: {
          method: 'GET',
          headers: {
            authorization: 'Bearer abc',
            cookie: 'sid=1',
            'x-step-up-token': 'su',
            'x-sign': 'sig',
            'x-trace-id': 'trace-1',
          },
        },
        res: { headers: { 'set-cookie': 'sid=2', 'content-type': 'application/json' } },
      },
      'http',
    );
    expect(records()[0]).toMatchObject({
      req: {
        method: 'GET',
        headers: {
          authorization: REDACTED,
          cookie: REDACTED,
          'x-step-up-token': REDACTED,
          'x-sign': REDACTED,
          'x-trace-id': 'trace-1',
        },
      },
      res: { headers: { 'set-cookie': REDACTED, 'content-type': 'application/json' } },
    });
    expect(lines[0]).not.toMatch(/Bearer abc|sid=1|sid=2|"su"|"sig"/);
  });
});

describe('PinoNestLogger', () => {
  it('maps Nest levels to pino levels and records the context', () => {
    const { logger, records } = capture('trace');
    const nest = new PinoNestLogger(logger);
    nest.log('Mapped route', 'RouterExplorer');
    nest.warn('careful', 'Some');
    nest.debug('dbg');
    nest.verbose('very');
    nest.fatal('dead', 'Boot');
    expect(records().map((record) => [record['level'], record['msg'], record['context']])).toEqual([
      [30, 'Mapped route', 'RouterExplorer'],
      [40, 'careful', 'Some'],
      [20, 'dbg', undefined],
      [10, 'very', undefined],
      [60, 'dead', 'Boot'],
    ]);
  });

  it('keeps the stack passed to error() and serialises Error objects', () => {
    const { logger, records } = capture();
    const nest = new PinoNestLogger(logger);
    nest.error('boom', 'Error: boom\n    at here', 'ExceptionsHandler');
    nest.error(new Error('kaput'), 'Bootstrap');
    nest.log({ shape: 'object' });
    const [first, second, third] = records();
    expect(first).toMatchObject({
      level: 50,
      msg: 'boom',
      stack: 'Error: boom\n    at here',
      context: 'ExceptionsHandler',
    });
    expect(second).toMatchObject({ level: 50, msg: 'kaput', context: 'Bootstrap' });
    expect((second?.['err'] as { message: string }).message).toBe('kaput');
    expect(third).toMatchObject({ level: 30, msg: '{"shape":"object"}' });
  });
});
