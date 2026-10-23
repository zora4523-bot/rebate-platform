import { randomInt } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { createIoredisTransport } from '../../../../apps/api/src/modules/platform/redis/ioredis-transport.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { setup as writeSetup, signInAgain, type SeedOptions } from '../admins-write/kit.ts';
import { SUPER, type Harness, type HttpApp, type Response } from '../auth/kit.ts';
import { contract } from '../exports/kit.ts';
import { ME, ok as stepOk, sender as smsSender, type Me } from '../step-up/kit.ts';

export { alive, expectAccount, harness, signInAgain, text } from '../admins-write/kit.ts';
export {
  error as stepError,
  ok as stepOk,
  SEND,
  STEP,
  validate as stepValidate,
  type Grant,
} from '../step-up/kit.ts';
export type Account = Schema<'AdminAccount'>;
export type Sent = Schema<'SendSmsCodeData'>;
export type VerifyPhone = Schema<'AdminVerifyPhone'>;

export const PATHS = {
  sendMine: '/admin/v1/me/verify-phone/sms-codes',
  changeMine: '/admin/v1/me/verify-phone',
  sendFor: `${SUPER}/{admin_id}/verify-phone/sms-codes`,
  changeFor: `${SUPER}/{admin_id}/verify-phone`,
} as const;
export type Operation = keyof typeof PATHS;
export const OPERATION_IDS: Record<Operation, string> = {
  sendMine: 'adminSendMyVerifyPhoneCode',
  changeMine: 'adminChangeMyVerifyPhone',
  sendFor: 'adminSendAdminVerifyPhoneCode',
  changeFor: 'adminChangeAdminVerifyPhone',
};
export const METHODS: Record<Operation, 'post' | 'put'> = {
  sendMine: 'post',
  changeMine: 'put',
  sendFor: 'post',
  changeFor: 'put',
};
/** Contract x-auth: the holder's own change is open to any signed-in account. */
export const AUTH: Record<Operation, 'admin' | 'super'> = {
  sendMine: 'admin',
  changeMine: 'admin',
  sendFor: 'super',
  changeFor: 'super',
};
/** Sending checks a totp-tier step-up; submitting the code checks none (contract). */
export const STEP_UP_OPERATIONS = ['sendMine', 'sendFor'] as const;
/** The send limit and code validity of POST /admin/v1/auth/step-up/sms-codes (contract). */
export const LIMITS: Sent = { resend_after_sec: 60, expires_in_sec: 300 };

const STATUS = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20002: 400,
  20003: 400,
  42901: 429,
} as const;
export type Code = keyof typeof STATUS;

/** An obviously fake mainland number (139 0000 xxxx) whose last 4 digits differ from `others`'. */
export function testPhone(...others: string[]): string {
  let candidate = '';
  do {
    candidate = `1390000${String(randomInt(10_000)).padStart(4, '0')}`;
  } while (others.some((other) => other.slice(-4) === candidate.slice(-4)));
  return candidate;
}

/** BR-ID-33 display mask (3 + 4). */
export function mask(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** The same number as typed or pasted: +86, a space and hyphens (BR-ID-05 normalisation). */
export function typed(phone: string): string {
  return `+86 ${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
}

/** A six-digit code other than `code`. */
export function wrong(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

/** The fake sender's record of a code sent to `phone` with the admin step-up template. */
export function smsTo(appId: string, phone: string) {
  return { app_id: appId, phone, purpose: 'step_up', code: expect.stringMatching(/^\d{6}$/) };
}

interface Injector {
  inject(request: {
    method: 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export interface Call {
  readonly token: string;
  readonly id?: string;
  readonly body?: object;
  readonly step?: string;
}

/** Raw request to one of the four operations on `app` (no step-up token unless given). */
export function requester(app: HttpApp) {
  // HttpApp's typed inject lists GET / POST / OPTIONS only; Fastify inject also takes PUT.
  const injector = app as unknown as Injector;
  return (operation: Operation, input: Call): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${input.token}` };
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    if (input.step !== undefined) headers['x-step-up-token'] = input.step;
    return injector.inject({
      method: METHODS[operation] === 'put' ? 'PUT' : 'POST',
      url: PATHS[operation].replace('{admin_id}', input.id ?? ''),
      headers,
      remoteAddress: '127.0.0.1',
      ...(input.body === undefined ? {} : { payload: JSON.stringify(input.body) }),
    });
  };
}

async function validate(response: Response, operation: Operation) {
  const responses = (await contract()).paths[PATHS[operation]]![METHODS[operation]]!.responses;
  const status =
    response.statusCode < 400
      ? String(response.statusCode)
      : response.statusCode === 429
        ? '429'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const schema = responses[status]?.content['application/json']?.schema;
  expect(schema, `契约应有 ${status} 响应`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export async function ok<T>(response: Response, operation: Operation): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, operation);
  return response.json<{ data: T }>().data;
}

/** An error envelope of the operation; without `data` the envelope must carry none. */
export async function error(response: Response, operation: Operation, code: Code, data?: object) {
  expect(response.statusCode).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code });
  if (data === undefined) expect(response.json()).not.toHaveProperty('data');
  else expect(response.json<{ data?: unknown }>().data).toEqual(data);
  await validate(response, operation);
}

/** No plain phone number and no code as a whole run of digits in `content` (BR-ID-33). */
export function expectNoPlain(
  content: string,
  phones: readonly string[],
  codes: readonly string[],
) {
  for (const phone of phones) expect(content).not.toContain(phone);
  const runs = content.split(/[^0-9]+/);
  for (const code of codes) expect(runs).not.toContain(code);
}

/** Read commands that list a key's members, by Redis type. */
const MEMBERS: Record<string, readonly (string | number)[]> = {
  hash: ['HGETALL'],
  list: ['LRANGE', 0, -1],
  set: ['SMEMBERS'],
  zset: ['ZRANGE', 0, -1],
};

/** Every key and value in the test Redis, as text (only the container runner executes this). */
export async function redisText(h: Harness): Promise<string> {
  const observer = createIoredisTransport(h.redis.url, {
    connectionName: 'b1-34i-observer',
    connectTimeoutMs: 2_000,
  });
  await observer.connect();
  try {
    const parts: string[] = [];
    let cursor = '0';
    do {
      const page = (await observer.call('SCAN', cursor, 'COUNT', 200)) as [string, string[]];
      cursor = page[0];
      for (const key of page[1]) {
        parts.push(key);
        const type = String(await observer.call('TYPE', key));
        if (type === 'string') parts.push(String(await observer.call('GET', key)));
        const read = MEMBERS[type];
        if (read !== undefined) {
          const [command, ...range] = read;
          parts.push(JSON.stringify(await observer.call(String(command), key, ...range)));
        }
      }
    } while (cursor !== '0');
    return parts.join('\n');
  } finally {
    observer.disconnect();
  }
}

interface CipherRow {
  readonly id: string;
  readonly verify_phone_cipher: Buffer | null;
}

/** B1-34h's fixture (super admin actor, real couli_app rows and Redis) plus the verify phone. */
export async function setup(h: Harness) {
  const f = await writeSetup(h);
  const call = requester(f.app);
  const auth = (adminToken: string) => ({ authorization: `Bearer ${adminToken}` });

  /** An account of the app signed in on its own session, with its totp-tier step-up. */
  const holder = async (options: SeedOptions = {}) => {
    const account = await f.target(options);
    const session = await signInAgain(f, account);
    const token = session.admin_token;
    return { account, token, issue: () => f.issue(account, token) };
  };

  const outbox = () => smsSender(f).outbox();
  /** The SMS the fake sender recorded for `phone`, oldest first. */
  const sentTo = (phone: string) => outbox().filter((item) => item.phone === phone);

  /** The latest SMS code that went to `phone`. */
  const lastCodeTo = (phone: string): string => {
    const message = sentTo(phone).at(-1);
    expect(message, `应有发往 ${mask(phone)} 的短信`).toBeDefined();
    expect(message!.code).toMatch(/^\d{6}$/);
    return message!.code;
  };

  /** The verify phone stored on the row, decrypted (same field context as the step-up SMS). */
  const phoneContext = (id: string) => `admin_users.verify_phone:${f.appId}:${id}`;
  const storedPhone = (row: CipherRow): string | null =>
    row.verify_phone_cipher === null
      ? null
      : h.fields.decrypt(row.verify_phone_cipher.toString(), phoneContext(row.id));

  /** POST /admin/v1/auth/step-up/sms-codes of the signed-in account. */
  const smsCode = (adminToken: string) => f.post('/step-up/sms-codes', {}, auth(adminToken));
  /** POST /admin/v1/auth/step-up. */
  const stepUp = (adminToken: string, tier: 'sms' | 'totp', code: string) =>
    f.post('/step-up', { tier, code }, auth(adminToken));
  /** GET /admin/v1/me/permissions. */
  const me = async (adminToken: string) => stepOk<Me>(await f.read(adminToken, ME), ME);

  return { ...f, call, holder, outbox, sentTo, lastCodeTo, storedPhone, smsCode, stepUp, me };
}
export type Setup = Awaited<ReturnType<typeof setup>>;
