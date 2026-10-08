import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2026-10-08T04:05:06.789Z';
export const TRACE = '0199a3b4-5c6d-7000-8000-000000000006';
export type AuthData = components['schemas']['UnionAuthUrlData'];

export interface Response {
  statusCode: number;
  json(): unknown;
}

export function success(response: Response): AuthData {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({
    code: 0,
    trace_id: TRACE,
    data: { auth_url: expect.any(String), state: expect.any(String) },
  });
  return (body as components['schemas']['UnionAuthUrlResponse']).data;
}

const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(
  value: unknown,
  name: 'UnionAuthUrlResponse' | 'ErrorEnvelope',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/** Length is a capacity check, not a proof of randomness; review must also verify the CSPRNG. */
export function expectOpaqueState(state: string, userId: string, deviceId: string): void {
  expect(state).not.toContain(userId);
  expect(state).not.toContain(deviceId);
  expect(state).not.toContain(userId.replaceAll('-', ''));
  expect(state).not.toContain(deviceId.replaceAll('-', ''));
  expect(state.length).toBeLessThanOrEqual(128);
  // Hex/base64url, optionally prefixed. A UUID alone has fewer than 128 random bits.
  const payload = state.replace(/^(?:st|state)[_-]/, '');
  const bits = /^[0-9a-f]+$/i.test(payload)
    ? payload.length * 4
    : /^[0-9a-f-]{36}$/i.test(payload)
      ? 122
      : /^[A-Za-z0-9_-]+={0,2}$/.test(payload)
        ? Buffer.from(payload, 'base64url').length * 8
        : 0;
  expect(bits).toBeGreaterThanOrEqual(128);
}

/** State changes per request; compare only the selected jump paths, preserving their order. */
export function normalizedJump(data: AuthData): unknown {
  expect(data.auth_jump).toBeDefined();
  return JSON.parse(
    JSON.stringify(data.auth_jump).replaceAll(encodeURIComponent(data.state), '<issued-state>'),
  ) as unknown;
}
