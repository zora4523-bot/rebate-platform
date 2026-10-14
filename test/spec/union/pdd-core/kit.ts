import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionErrorCode,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  PddUnionAdapter,
  type PddAdapterOptions,
} from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';

// Task-local AC labels identify the task's acceptance points, not new business-rule IDs.
// These are in-memory doc-derived envelopes, not probe recordings or mapped business DTOs.
export const method = 'pdd.ddk.order.list.increment.get';
export const endpoint: UnionEndpoint = {
  platform: 'pdd',
  mode: 'live',
  baseUrl: 'https://pdd-gateway.invalid/api/router',
  quotaKey: 'pdd-example',
};
export const secret = 'testSecret';

export function response(body: unknown, status = 200): UnionTransportResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function setup(overrides: Partial<PddAdapterOptions> = {}) {
  const clock = new FixedClock('2016-11-29T08:38:45.999Z');
  const credentials = vi.fn(async () => ({ clientId: '1', clientSecret: secret }));
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue(response({ order_list_get_response: {} }));
  const warn = vi.fn();
  const adapter = new PddUnionAdapter({
    clock,
    credentials,
    transport,
    endpoint,
    warn,
    ...overrides,
  });
  return { adapter, clock, credentials, transport, warn };
}

export function bodyOf(request: UnionTransportRequest): Record<string, unknown> {
  expect(request.body).toBeTypeOf('string');
  return JSON.parse(request.body!) as Record<string, unknown>;
}

export function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

export async function unionFailure(
  run: () => unknown | Promise<unknown>,
  code: UnionErrorCode,
): Promise<UnionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'pdd' });
  return caught as UnionError;
}

export function expectRedacted(value: unknown, markers: readonly string[]): void {
  const visible = `${String(value)}\n${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
  for (const marker of markers) expect(visible).not.toContain(marker);
}
