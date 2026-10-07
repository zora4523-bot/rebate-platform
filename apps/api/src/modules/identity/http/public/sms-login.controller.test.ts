import { fileURLToPath } from 'node:url';
import { HttpException } from '@nestjs/common';
import { dereference } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import type { OpenAPIV3_1 } from 'openapi-types';
import { beforeAll, expect, it, vi } from 'vitest';
import type {
  SmsLoginCommand,
  SmsLoginResult,
  SmsLoginService,
} from '../../application/sms-login.ts';
import { SmsLoginController, smsLoginErrorResponse } from './sms-login.controller.ts';

const CONTRACT = fileURLToPath(
  new URL('../../../../../../../contracts/openapi.yaml', import.meta.url),
);
const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';

type Validate = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type Status = '200' | '4XX' | '5XX';
const validators = new Map<Status, Validate>();

beforeAll(async () => {
  const document = await dereference<OpenAPIV3_1.Document>(CONTRACT, {
    resolve: { external: false },
  });
  const responses = document.paths?.['/v1/auth/login/sms']?.post?.responses ?? {};
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  for (const status of ['200', '4XX', '5XX'] as const) {
    const response = responses[status] as OpenAPIV3_1.ResponseObject | undefined;
    validators.set(status, ajv.compile(response?.content?.['application/json']?.schema as object));
  }
});

function valid(status: Status, body: unknown): void {
  const validate = validators.get(status)!;
  const ok = validate(body);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

it('[BR-ID-01][BR-ID-05] every refused login maps to its contract status and a valid ErrorEnvelope', () => {
  const cases: [Exclude<SmsLoginResult, { code: 0 }>, number, '4XX' | '5XX'][] = [
    [{ code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } }, 400, '4XX'],
    [{ code: 20002 }, 400, '4XX'],
    [{ code: 20003 }, 400, '4XX'],
    [{ code: 44001 }, 403, '4XX'],
    [{ code: 44001, data: { risk_msg_code: 'blocked' } }, 403, '4XX'],
    [{ code: 10405, data: { reason: 'no_account', min_supported_version: '3.0.0' } }, 403, '4XX'],
    [{ code: 10405, data: { reason: 'no_account', min_supported_version: null } }, 403, '4XX'],
    [{ code: 50001 }, 500, '5XX'],
  ];
  for (const [result, status, schema] of cases) {
    const response = smsLoginErrorResponse(result, TRACE);
    expect(response.statusCode).toBe(status);
    expect(response.body).toMatchObject({ code: result.code, trace_id: TRACE });
    expect(response.body.msg).not.toBe('');
    valid(schema, response.body);
  }
  expect(smsLoginErrorResponse(cases[0]![0], TRACE).body.data).toEqual({
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  expect(smsLoginErrorResponse(cases[3]![0], TRACE).body).not.toHaveProperty('data');
  expect(smsLoginErrorResponse(cases[4]![0], TRACE).body.data).toEqual({
    risk_msg_code: 'blocked',
  });
  expect(smsLoginErrorResponse(cases[6]![0], TRACE).body.data).toEqual({
    reason: 'no_account',
    min_supported_version: null,
  });
});

const BODY = {
  phone: '13800138000',
  code: '123456',
  legal_versions: { privacy: 3, agreement: 2 },
  consent_at: '2026-10-08T03:59:55.000Z',
};
const TOKENS = {
  session_scope: 'deletion_only' as const,
  access_token: 'a',
  access_expires_at: '2026-10-08T06:00:00.000Z',
  refresh_token: 'r',
  refresh_expires_at: '2026-11-07T04:00:00.000Z',
};

function controller(result: SmsLoginResult | null, headers: Record<string, string>) {
  const login = vi.fn(async (command: SmsLoginCommand) => {
    void command;
    return result!;
  });
  const service = result === null ? null : ({ login } satisfies SmsLoginService);
  const request = {
    id: TRACE,
    ip: '203.0.113.7',
    headers,
    verifiedDevice: { deviceId: 'd1', appId: 'couli' },
    body: BODY,
  };
  return { target: new SmsLoginController(service), login, request };
}

it('[BR-ID-01][BR-ID-04] the controller passes the verified app and device, the client headers and IP, and answers 200 per contract', async () => {
  const data = {
    user_id: '0192a8b0-0000-7000-8000-000000000001',
    is_new_user: false,
    tokens: TOKENS,
  };
  const c = controller(
    { code: 0, data },
    { 'x-app-id': 'other', 'x-platform': 'ios', 'x-channel': 'appstore', 'x-app-version': '1.0.3' },
  );
  const body = await c.target.login(c.request);
  valid('200', body);
  expect(body).toEqual({ code: 0, msg: '', data, trace_id: TRACE });
  expect(c.login).toHaveBeenCalledExactlyOnceWith({
    body: BODY,
    app_id: 'couli',
    device_id: 'd1',
    platform: 'ios',
    channel: 'appstore',
    version: '1.0.3',
    client_ip: '203.0.113.7',
  });
});

it('[BR-ID-01] without X-Channel the command carries no channel; a refusal throws its envelope', async () => {
  const c = controller(
    { code: 10405, data: { reason: 'no_account', min_supported_version: '3.0.0' } },
    { 'x-platform': 'h5', 'x-app-version': '1.0.0' },
  );
  const error = await c.target.login(c.request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(403);
  valid('4XX', (error as HttpException).getResponse());
  expect(c.login.mock.calls[0]![0]).not.toHaveProperty('channel');
});

it('[BR-ID-04] without the service or a verified device the request fails closed', async () => {
  const missing = controller(null, { 'x-platform': 'ios' });
  await expect(missing.target.login(missing.request)).rejects.toThrow(/SMS login needs/);
  const unverified = controller({ code: 20002 }, { 'x-platform': 'ios' });
  const { verifiedDevice, ...request } = unverified.request;
  void verifiedDevice;
  await expect(unverified.target.login(request)).rejects.toThrow(/verified device/);
  expect(unverified.login).not.toHaveBeenCalled();
});
