import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { expect } from 'vitest';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { isServerIdentity } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import type { Fixture } from './kit.ts';

const root = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', root));
let schemas: Promise<Record<string, JsonSchema>> | undefined;

export async function response(result: unknown, code: number, status: number) {
  expect(result).toMatchObject({ status, envelope: { code } });
  const value = result as HandlerResult;
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)))
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({
    schema: (await schemas)[code === 0 ? 'OpenLinkResponse' : 'ErrorEnvelope']!,
    httpPart: 'body',
  });
  expect(check(value.envelope), JSON.stringify(check.errors)).toBe(true);
  expect(JSON.stringify(value.envelope)).not.toContain('user_id');
  return value;
}

export async function success(result: unknown) {
  const data = (await response(result, 0, 200)).envelope
    .data as components['schemas']['OpenLinkResult'];
  for (const step of [data.jump.primary, ...data.jump.fallbacks]) {
    expect(step.type).not.toBe('sdk');
    expect(step).not.toHaveProperty('sdk');
  }
  return data;
}

export function identity(f: Fixture, value: unknown, attr: string, scene: string) {
  expect(isServerIdentity(value)).toBe(true);
  expect(value).toMatchObject({
    claims: {
      appId: f.appId,
      platform: 'pdd',
      promotionSlot: `current-pdd-${scene}`,
      userId: attr,
      relationId: null,
    },
    custom_parameters: { app: 'n', uid: attr, sc: scene },
  });
  const parameters = (value as JdPddIdentity).custom_parameters;
  expect(parameters).toEqual({ app: 'n', uid: attr, sc: scene });
  const serialized = JSON.stringify(value);
  for (const privateValue of [
    'user_id',
    'device_id',
    f.a.userId,
    f.b.userId,
    f.a.deviceId,
    f.b.deviceId,
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
}

export function noAuthEntry(result: HandlerResult) {
  for (const field of ['auth_jump', 'auth_url', 'state']) {
    expect(result.envelope.data ?? {}).not.toHaveProperty(field);
  }
}

export async function noConversion(f: Fixture) {
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.attempts()).toEqual([]);
}
