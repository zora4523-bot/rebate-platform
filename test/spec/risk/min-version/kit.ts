import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  createMinimumVersionCheck,
  type MinimumVersionReader,
  type MinimumVersionRequest,
  type MinimumVersionRoute,
} from '../../../../apps/api/src/modules/risk/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
export const TRACE = 'b103c000000000000000000000000001';
export const PRINCIPAL = {
  uid: '019a0000-0000-7000-8000-000000000010',
  app_id: 'couli',
  sid: 'test-session',
  device_id: '019a0000-0000-7000-8000-000000000001',
  scp: 'full' as const,
};
export const HEADERS = {
  'x-app-id': 'couli',
  'x-platform': 'ios',
  'x-channel': 'app_store',
  'x-app-version': '1.0.0',
};

export function request(overrides: Partial<MinimumVersionRequest> = {}): MinimumVersionRequest {
  return {
    id: TRACE,
    method: 'POST',
    headers: HEADERS,
    routeOptions: { url: '/v1/withdrawals' },
    body: {},
    principal: PRINCIPAL,
    ...overrides,
  };
}

export function fixture(minimum: string | null = '2.10.3') {
  const read = vi.fn<MinimumVersionReader['minSupportedVersion']>(async () => minimum);
  return { read, check: createMinimumVersionCheck({ minSupportedVersion: read }) };
}

/** Preserve unexpected errors: NotImplemented remains a legitimate red, never a fake 10405. */
export async function rejection(call: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await call();
  } catch (error) {
    caught = error;
  }
  if (caught instanceof Error && caught.message.startsWith('NotImplemented:')) throw caught;
  expect(caught).toBeDefined();
  const error = caught as
    | {
        getStatus?: () => number;
        getResponse?: () => unknown;
      }
    | undefined;
  expect(typeof error?.getStatus).toBe('function');
  expect(typeof error?.getResponse).toBe('function');
  expect(error?.getStatus?.()).toBe(403);
  return error?.getResponse?.();
}

export async function expectBlocked(call: () => Promise<unknown>, minimum: string | null) {
  const envelope = await rejection(call);
  expect(envelope).toEqual({
    code: 10405,
    msg: expect.any(String),
    data: { min_supported_version: minimum },
    trace_id: TRACE,
  });
  return envelope;
}

interface Operation {
  operationId: string;
  'x-min-version-gate'?: boolean | 'conditional';
  'x-session-scopes'?: ('full' | 'deletion_only')[];
  'x-idempotent'?: boolean;
}

export async function contractRoutes(): Promise<MinimumVersionRoute[]> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, Partial<Record<string, Operation>>>;
    }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].flatMap((method) => {
      const op = item[method];
      return op === undefined
        ? []
        : [
            {
              operationId: op.operationId,
              method: method.toUpperCase(),
              path: path.replace(/\{([^}]+)\}/g, ':$1'),
              gate: op['x-min-version-gate'] ?? null,
              sessionScopes: op['x-session-scopes'] ?? ['full'],
              idempotent: op['x-idempotent'] === true,
            },
          ];
    }),
  );
}

export function forRoute(route: MinimumVersionRoute, body: unknown = {}): MinimumVersionRequest {
  return request({ method: route.method, routeOptions: { url: route.path }, body });
}

/** Independent examples from task §9.1; never derived from implementation policy data. */
export const CONDITIONAL = [
  ...['/v1/auth/sms-codes', '/v1/auth/oauth-attempts'].flatMap((path) => [
    { path, body: { purpose: 'login' }, allowed: true },
    { path, body: { purpose: 'step_up', action: 'account_deletion' }, allowed: true },
    { path, body: { purpose: 'step_up' }, allowed: false },
    { path, body: { purpose: 'step_up', action: 'withdraw' }, allowed: false },
    { path, body: { purpose: 'step_up', action: 'phone_change' }, allowed: false },
    { path, body: { purpose: 'step_up', action: 'payout_account_change' }, allowed: false },
  ]),
  {
    path: '/v1/auth/sms-codes',
    body: { purpose: 'bind', action: 'account_deletion' },
    allowed: false,
  },
  { path: '/v1/auth/oauth-attempts', body: { purpose: 'payout_bind' }, allowed: false },
  ...['/v1/auth/step-up', '/v1/idempotency-keys/abandon'].flatMap((path) => [
    { path, body: { action: 'account_deletion' }, allowed: true },
    ...['withdraw', 'phone_change', 'payout_account_change'].map((action) => ({
      path,
      body: { action },
      allowed: false,
    })),
    { path, body: {}, allowed: false },
  ]),
  ...[
    'privacy',
    'agreement',
    'personalization',
    'ai_third_party',
    'id_verification',
    'labor_agreement',
  ].flatMap((type) =>
    [true, false].map((accepted) => ({
      path: '/v1/consents',
      body: { type, accepted },
      allowed: !accepted || type === 'privacy' || type === 'agreement',
    })),
  ),
  { path: '/v1/consents', body: { type: 'personalization', accepted: 'false' }, allowed: false },
];
