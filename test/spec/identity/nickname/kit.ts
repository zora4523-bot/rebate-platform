// B1-20d PATCH /v1/me (change the nickname) rule tests: shared fixtures. Real PG + Redis and the
// real AppModule (APP_ENV=test) through the me kit (test/spec/identity/me/http-kit.ts); service
// cases build the use case with an injected NicknameReviewPort. Fixtures write rows directly
// (test-owned setup) and never call a B1-20d skeleton; the skeletons are imported dynamically
// inside the test bodies only. Sources: 08 BR-ID-39 (+ 细则), BR-ID-04 细则 (default nickname
// 「用户」+ last 4 of the user id); 04 §6.1; 10 AC-S1-61; task brief §9.3, §9.4 (D30, D31, D32).
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Response } from '../sms-codes/http-kit.ts';
import { fixture as meFixture, ME, NICKNAME, type Kit } from '../me/http-kit.ts';

export {
  openKit,
  closeKit,
  me,
  ME,
  NICKNAME,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_URL,
  type Kit,
} from '../me/http-kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
type UpdateModule =
  typeof import('../../../../apps/api/src/modules/identity/application/update-nickname.ts');
type ReviewModule =
  typeof import('../../../../apps/api/src/modules/identity/infra/nickname-review.ts');
export type ReviewPort =
  import('../../../../apps/api/src/modules/identity/ports/nickname-review.ts').NicknameReviewPort;
export type ReviewInput = Parameters<ReviewPort['review']>[0];
export type Verdict = Awaited<ReturnType<ReviewPort['review']>>;
export type UpdateResult = Awaited<
  ReturnType<ReturnType<UpdateModule['createUpdateNicknameService']>['update']>
>;

/**
 * A word the seed list infra/sensitive-words.nickname.txt must name (§9.4 D32): written here,
 * not read from the implementation. The HTTP cases run the real APP_ENV=test review on it.
 */
export const SEED_WORD = '赌博';
/** The fixture clock (me kit: CREATED + 1 h = 2031-05-06T08:08:09Z) is in this +08:00 month. */
export const FIXTURE_MONTH = '2031-05';
export const CHANGED = 'identity_nickname_changed';
export const SENSITIVE_MSG = '昵称含不允许使用的内容，请修改';
export const EXHAUSTED_MSG = '本月昵称修改次数已用完，下月可再修改';

/** BR-ID-04 细则: 「用户」 + the last 4 characters of the user id (lower case). */
export function defaultNicknameOf(uid: string): string {
  return '用户' + uid.toLowerCase().slice(-4);
}

export interface NicknameOptions {
  appId?: string;
  /** The current nickname; 'default' = the BR-ID-04 default of the new user. */
  nickname?: string | 'default';
  month?: string | null;
  count?: number;
}

type PatchApp = {
  inject(options: {
    method: 'PATCH' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
};

/**
 * The me kit's user (new app unless appId, created at CREATED, nickname NICKNAME) with the
 * nickname columns set as asked. The PATCH session is created at the first patch(), at the clock
 * of that moment, so a test may move the clock before its first request.
 */
export async function nicknameFixture(kit: Kit, options: NicknameOptions = {}) {
  const f = await meFixture(kit, options.appId === undefined ? {} : { appId: options.appId });
  const nickname =
    options.nickname === undefined
      ? NICKNAME
      : options.nickname === 'default'
        ? defaultNicknameOf(f.uid)
        : options.nickname;
  await sql`UPDATE app.users SET nickname = ${nickname},
      nickname_change_month = ${options.month ?? null},
      nickname_change_count = ${options.count ?? 0}
    WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(kit.suite.db);
  let token: { deviceId: string; access: string } | undefined;
  const headers = {
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const app = kit.app as unknown as PatchApp;
  const session = async () => {
    if (token !== undefined) return token;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
    });
    expect(created.statusCode).toBe(200);
    const { device_id } = created.json<{ data: { device_id: string } }>().data;
    const { TOKEN_SERVICE } = (await import(
      new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
    )) as { TOKEN_SERVICE: symbol };
    const { createSession } = (await import(
      new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
    )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
    const tokens = kit.app.get<Parameters<typeof createSession>[2]['tokens']>(TOKEN_SERVICE);
    const issued = await kit.suite.db
      .withSchema('app')
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid: f.uid, app_id: f.appId, device_id, scp: 'full' },
          { clock: kit.clock, tokens },
        ),
      );
    token = { deviceId: device_id, access: issued.access_token };
    return token;
  };
  return {
    ...f,
    nickname,
    /** PATCH /v1/me with this user's full session and the given JSON body. */
    async patch(body: unknown): Promise<Response> {
      const t = await session();
      return app.inject({
        method: 'PATCH',
        url: ME,
        headers: {
          ...headers,
          'x-device-id': t.deviceId,
          'content-type': 'application/json',
          authorization: `Bearer ${t.access}`,
        },
        payload: JSON.stringify(body),
      });
    },
  };
}
export type NicknameFixture = Awaited<ReturnType<typeof nicknameFixture>>;

/**
 * The nickname columns of a user row (what a change may touch), plus avatar (what a change must
 * never touch: MVP avatars are not editable, OPS-13 / 04 §6.1).
 */
export async function columns(f: NicknameFixture) {
  const row = await f.row();
  return {
    nickname: row.nickname,
    avatar: row.avatar,
    month: row.nickname_change_month,
    count: Number(row.nickname_change_count),
    row_version: Number(row.row_version),
    updated_at: new Date(row.updated_at as unknown as string | Date).getTime(),
  };
}

function validated(kit: Kit, response: Response, status: '200' | '4XX'): unknown {
  const body = response.json<unknown>();
  const operation = kit.document.paths[ME]!['patch'] as unknown as {
    responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
  };
  const schema = operation.responses[status]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

/** A success: HTTP 200, {code:0, msg:'', data:{}, trace_id} and the contract's 200 schema. */
export function ok(kit: Kit, response: Response): void {
  expect(response.statusCode).toBe(200);
  const body = response.json<Record<string, unknown>>();
  expect(body).toEqual({ code: 0, msg: '', data: {}, trace_id: expect.any(String) });
  validated(kit, response, '200');
}

/** A 20001 with data.fields (HTTP 400, contract 4XX schema); returns the fields. */
export function fieldsError(kit: Kit, response: Response): string[] {
  expect(response.statusCode).toBe(400);
  const body = response.json<{ code: number; data: { fields?: unknown; reason?: unknown } }>();
  expect(body.code).toBe(20001);
  expect(Array.isArray(body.data?.fields)).toBe(true);
  expect(body.data.reason).toBeUndefined();
  validated(kit, response, '4XX');
  return body.data.fields as string[];
}

/** A 20001 with data exactly {reason:'nickname_sensitive'} (no fields; HTTP 400). */
export function sensitiveError(kit: Kit, response: Response): void {
  expect(response.statusCode).toBe(400);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ code: 20001, msg: SENSITIVE_MSG, trace_id: expect.any(String) });
  expect(body['data']).toEqual({ reason: 'nickname_sensitive' });
  validated(kit, response, '4XX');
}

/** A 30415: HTTP 422 (contracts/error-codes.yaml) and the default text. */
export function exhaustedError(kit: Kit, response: Response): void {
  expect(response.statusCode).toBe(422);
  const body = response.json<Record<string, unknown>>();
  expect(body).toMatchObject({ code: 30415, msg: EXHAUSTED_MSG, trace_id: expect.any(String) });
  validated(kit, response, '4XX');
}

/** The parsed pino lines whose event (msg, or an `event` field) is identity_nickname_changed. */
export function changeLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['msg'] === CHANGED || entry['event'] === CHANGED);
}

/** The use case with the given review port, the kit's database and clock, and the given logger. */
export async function nicknameService(
  kit: Kit,
  review: ReviewPort,
  logger: import('../../../../apps/api/src/modules/platform/logging/logger.ts').RootLogger,
) {
  const { createUpdateNicknameService } = (await import(
    new URL('apps/api/src/modules/identity/application/update-nickname.ts', ROOT).href
  )) as UpdateModule;
  return createUpdateNicknameService({ db: kit.suite.db, clock: kit.clock, logger, review });
}

/** infra/nickname-review.ts, imported dynamically. */
export async function reviewModule(): Promise<ReviewModule> {
  return (await import(
    new URL('apps/api/src/modules/identity/infra/nickname-review.ts', ROOT).href
  )) as ReviewModule;
}

/** A review port answering `verdict` (or throwing it), recording every input. */
export function scriptedReview(verdict: Verdict | Error) {
  const calls: ReviewInput[] = [];
  const port: ReviewPort = {
    async review(input) {
      calls.push(input);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
  return { calls, port };
}

/**
 * A 'pass' review that holds every caller until `n` callers are waiting (or 3 s passed), so that
 * n concurrent changes all pass the quota pre-read before any of them writes.
 */
export function gatedReview(n: number) {
  const calls: ReviewInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release(), 3_000);
  const port: ReviewPort = {
    async review(input) {
      calls.push(input);
      if (calls.length >= n) {
        clearTimeout(timer);
        release();
      }
      await gate;
      return 'pass';
    },
  };
  return { calls, port };
}

/**
 * `promise` settled within `ms`, else a rejection naming `label` (so a held review, a held row
 * lock or a never-answering use case fails the test instead of hanging it).
 */
export async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A review that does not answer until the test calls `answer(verdict)`. `reached` resolves when
 * the use case has entered review, so the test can look at the row while the review is pending.
 */
export function heldReview() {
  const calls: ReviewInput[] = [];
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let answer!: (verdict: Verdict) => void;
  const verdict = new Promise<Verdict>((resolve) => {
    answer = resolve;
  });
  const port: ReviewPort = {
    async review(input) {
      calls.push(input);
      entered();
      return verdict;
    },
  };
  return { calls, port, reached, answer };
}
