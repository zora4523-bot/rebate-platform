import { expect, expectTypeOf, it } from 'vitest';
import { createApiClient, type Schema, type operations } from './index.ts';

type HealthzResponse = Schema<'HealthzResponse'>;

const body: HealthzResponse = {
  code: 0,
  msg: '',
  data: { status: 'ok', entry: 'api', now: '2026-10-01T04:00:00.000Z' },
  trace_id: 'trace-1',
};

it('calls GET /healthz through the injected fetch and returns the typed envelope', async () => {
  const seen: Request[] = [];
  const fakeFetch = (input: Request): Promise<Response> => {
    seen.push(input);
    return Promise.resolve(Response.json(body));
  };
  const client = createApiClient('http://127.0.0.1:3100', { fetch: fakeFetch });

  const { data, error, response } = await client.GET('/healthz');

  expectTypeOf(data).toEqualTypeOf<HealthzResponse | undefined>();
  expectTypeOf<
    operations['getHealthz']['responses'][200]['content']['application/json']
  >().toEqualTypeOf<HealthzResponse>();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe('GET');
  expect(seen[0]?.url).toBe('http://127.0.0.1:3100/healthz');
  expect(response.status).toBe(200);
  expect(error).toBeUndefined();
  expect(data).toEqual(body);
});

it('passes default headers from init and reports non-2xx responses as error', async () => {
  const seen: Request[] = [];
  const fakeFetch = (input: Request): Promise<Response> => {
    seen.push(input);
    return Promise.resolve(Response.json({ code: 50000, msg: 'boom' }, { status: 500 }));
  };
  const client = createApiClient('http://127.0.0.1:3100/', {
    fetch: fakeFetch,
    headers: { 'x-trace-id': 'trace-2' },
  });

  const { data, error, response } = await client.GET('/healthz');

  expect(seen[0]?.url).toBe('http://127.0.0.1:3100/healthz');
  expect(seen[0]?.headers.get('x-trace-id')).toBe('trace-2');
  expect(response.status).toBe(500);
  expect(data).toBeUndefined();
  expect(error).toEqual({ code: 50000, msg: 'boom' });
});
