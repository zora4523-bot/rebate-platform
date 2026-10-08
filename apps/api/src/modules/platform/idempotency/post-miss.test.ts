import { expect, it } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { createIdempotency, type Idempotency, type IdempotentRequest } from './index.ts';
import { registerIdempotencyEntryObserver, registerIdempotencyPostMissCheck } from './post-miss.ts';

it('[BR-ID-01] registration refuses an object that createIdempotency did not build', () => {
  expect(() => registerIdempotencyPostMissCheck({} as Idempotency, async () => undefined)).toThrow(
    TypeError,
  );
});

it('[BR-ID-01] an entry observer sees every request first, even one refused before any lookup', async () => {
  const idempotency = createIdempotency({
    db: {} as never,
    clock: new FixedClock('2031-01-01T00:00:00Z'),
    logger: { warn: () => undefined },
  });
  const seen: string[] = [];
  registerIdempotencyEntryObserver(idempotency, (request) => seen.push(`a:${request.traceId}`));
  registerIdempotencyEntryObserver(idempotency, (request) => seen.push(`b:${request.traceId}`));
  const request: IdempotentRequest = {
    appId: 'couli',
    actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
    method: 'POST',
    path: '/v1/links/l/open',
    key: 'not a uuid',
    body: {},
    traceId: 't1',
  };
  const handler = async () => ({ status: 200, envelope: { code: 0, msg: '', trace_id: 't1' } });
  expect(JSON.parse((await idempotency.execute(request, handler)).body)).toMatchObject({
    code: 20001,
  });
  await idempotency.executeInTransaction({ ...request, traceId: 't2' }, handler);
  expect(seen).toEqual(['a:t1', 'b:t1', 'a:t2', 'b:t2']);
  expect(() => registerIdempotencyEntryObserver({} as Idempotency, () => undefined)).toThrow(
    TypeError,
  );
});
