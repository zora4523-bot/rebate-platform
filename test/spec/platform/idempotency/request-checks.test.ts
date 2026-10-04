// Rule tests that need no database: who owns a key (规划/04 §5「幂等」 subject), the key format
// and the 20001 envelope (04 §5 缺少返回 20001; contracts IdempotencyKey), programming errors,
// the sensitive operations that must run in a transaction (BR-ID-10 细则「敏感操作的幂等键」), the
// factory options and the input checks of the abandon primitive (04 §6.1). Contract sections
// 1, 2, 4, 5, 6, 8, 9 and 10 of apps/api/src/modules/platform/idempotency/index.ts. A poison
// database handle proves that refusals happen before any database access.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createIdempotency,
  subjectOf,
  type Idempotency,
  type IdempotencyErrorCode,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  ACTIONS,
  DEVICE_A,
  POISON_DB_MESSAGE,
  RESPONSES,
  SENSITIVE,
  TRACE,
  USER_A,
  hmacOf,
  idempotencyErrorProblems,
  outcome,
  outcomeSync,
  poisonDb,
  recordingLogger,
  request,
  result,
  sensitiveRequest,
  uuidOf,
} from './kit.ts';

const MESSAGES: Record<IdempotencyErrorCode, string> = {
  invalid_option: 'processingLeaseMs must be an integer from 1000 to 600000',
  invalid_subject: 'the request has no valid idempotency subject',
  invalid_request: 'the idempotent request is invalid',
  invalid_result: 'the handler returned an invalid result',
  transactional_required: 'this operation must use executeInTransaction',
  outcome_unknown: 'the transaction outcome is unknown',
};

const POISONED = { error: `Error: ${POISON_DB_MESSAGE}` };

/**
 * An idempotency instance over a poison database handle. It is created on first use, inside the
 * call under test, so that a factory failure shows as the call's outcome.
 */
function poisoned(): { idem: Idempotency } {
  const { logger } = recordingLogger();
  const make = () =>
    createIdempotency({
      db: poisonDb(),
      clock: new FixedClock('2031-05-06T07:08:09.123Z'),
      logger,
    });
  const idem: Idempotency = {
    execute: (req, handler) => make().execute(req, handler),
    executeInTransaction: (req, handler) => make().executeInTransaction(req, handler),
    abandon: (req) => make().abandon(req),
    purgeExpired: () => make().purgeExpired(),
  };
  return { idem };
}

it('[规划/04 §5「幂等」] 主体：已登录 u:<user_id>；匿名带设备号 d:<device_id>；落地页 p:<phone_hmac>；按用户 → 设备 → 手机号取第一个非空的', () => {
  const phone = hmacOf('landing-phone');
  expect(outcomeSync(() => subjectOf({ userId: USER_A, deviceId: null, phoneHmac: null }))).toBe(
    `u:${USER_A}`,
  );
  expect(
    outcomeSync(() => subjectOf({ userId: USER_A, deviceId: DEVICE_A, phoneHmac: phone })),
  ).toBe(`u:${USER_A}`);
  expect(outcomeSync(() => subjectOf({ userId: null, deviceId: DEVICE_A, phoneHmac: phone }))).toBe(
    `d:${DEVICE_A}`,
  );
  expect(outcomeSync(() => subjectOf({ userId: null, deviceId: null, phoneHmac: phone }))).toBe(
    `p:${phone}`,
  );
});

it('[规划/04 §5「幂等」] 主体格式：用户与设备是小写规范 UUID，手机号盲索引是 64 位小写十六进制；全空或胜出的值格式不符 → IdempotencyError invalid_subject；落选的值不检查', () => {
  const invalid: [string | null, string | null, string | null][] = [
    [null, null, null],
    [USER_A.toUpperCase(), null, null],
    ['', DEVICE_A, null],
    [`{${USER_A}}`, null, null],
    [USER_A.replaceAll('-', ''), null, null],
    [null, `${DEVICE_A} `, null],
    [null, 'device-1', null],
    [null, null, hmacOf('p').toUpperCase()],
    [null, null, hmacOf('p').slice(1)],
    [null, null, `${hmacOf('p')}0`],
    [null, null, ''],
  ];
  for (const [userId, deviceId, phoneHmac] of invalid) {
    expect(outcomeSync(() => subjectOf({ userId, deviceId, phoneHmac }))).toEqual({
      error: 'IdempotencyError invalid_subject',
    });
  }
  expect(
    outcomeSync(() => subjectOf({ userId: USER_A, deviceId: 'not a uuid', phoneHmac: 'x' })),
  ).toBe(`u:${USER_A}`);
  expect(outcomeSync(() => subjectOf({ userId: null, deviceId: DEVICE_A, phoneHmac: 'x' }))).toBe(
    `d:${DEVICE_A}`,
  );
  let caught: unknown;
  try {
    subjectOf({ userId: null, deviceId: null, phoneHmac: null });
  } catch (error) {
    caught = error;
  }
  expect(idempotencyErrorProblems(caught, 'invalid_subject', MESSAGES.invalid_subject)).toEqual([]);
});

it('[规划/04 §5「幂等」; contracts IdempotencyKey] 缺少或格式不符的 Idempotency-Key → 20001（HTTP 400，data.fields=[idempotency-key]，信封逐字节确切），不调用处理函数、不碰数据库', async () => {
  const badKeys: (string | undefined)[] = [
    undefined,
    '',
    'abc_123',
    'a'.repeat(65),
    'abcdefg.h',
    'abcd efgh',
    'abcdefgé',
    'abcdefgh\n',
    ' abcdefgh',
    'abcd/efgh',
    'abcd+efgh',
    'abcd=efgh',
  ];
  for (const key of badKeys) {
    const { idem } = poisoned();
    let calls = 0;
    const handler = () => {
      calls += 1;
      return Promise.resolve(result(0, 200));
    };
    expect(await outcome(() => idem.execute(request({ key }), handler))).toStrictEqual(
      RESPONSES.e20001,
    );
    expect(
      await outcome(() =>
        idem.executeInTransaction(sensitiveRequest('withdraw', { key }), handler),
      ),
    ).toStrictEqual(RESPONSES.e20001);
    expect(calls).toBe(0);
  }
});

it('[contracts IdempotencyKey] 8 与 64 个字符、含 _ 与 - 的键都合格（通过格式检查后才查库：毒化的句柄被用到）', async () => {
  for (const key of ['abcdefgh', 'A'.repeat(64), 'a_b-C_9-', '-_-_-_-_', '01234567']) {
    const { idem } = poisoned();
    expect(
      await outcome(() => idem.execute(request({ key }), () => Promise.resolve(result(0, 200)))),
    ).toEqual(POISONED);
  }
});

it('[规划/04 §5「幂等」] 20001 等信封的 trace_id 取请求的 traceId，键顺序 code、msg、data、trace_id', async () => {
  const { idem } = poisoned();
  const trace = uuidOf(0x7777);
  expect(
    await outcome(() =>
      idem.execute(request({ key: undefined, traceId: trace }), () =>
        Promise.resolve(result(0, 200)),
      ),
    ),
  ).toStrictEqual({
    status: 400,
    body: `{"code":20001,"msg":"Idempotency-Key is missing or malformed","data":{"fields":["idempotency-key"]},"trace_id":"${trace}"}`,
    source: 'idempotency',
  });
});

it('[规划/04 §5 step-up 行; BR-ID-10 细则「敏感操作的幂等键」] 四个需要二次验证的操作（POST /v1/me/phone 含首次绑定）不能走普通模式：execute 抛 IdempotencyError transactional_required，不调用处理函数、不碰数据库', async () => {
  for (const action of ACTIONS) {
    const { idem } = poisoned();
    let calls = 0;
    const got = await outcome(() =>
      idem.execute(sensitiveRequest(action), () => {
        calls += 1;
        return Promise.resolve(result(0, 200));
      }),
    );
    expect(got).toEqual({ error: 'IdempotencyError transactional_required' });
    expect(calls).toBe(0);
  }
  const { idem } = poisoned();
  let caught: unknown;
  try {
    await idem.execute(sensitiveRequest('phone_change', { body: { phone: 'x' } }), () =>
      Promise.resolve(result(0, 200)),
    );
  } catch (error) {
    caught = error;
  }
  expect(
    idempotencyErrorProblems(caught, 'transactional_required', MESSAGES.transactional_required),
  ).toEqual([]);
  // Other methods or paths that merely resemble them stay in the standard mode.
  for (const [method, path] of [
    ['GET', '/v1/withdrawals'],
    ['POST', '/v1/withdrawals/rules'],
    ['POST', '/v1/me/payout-account'],
    ['PUT', '/v1/me/phone'],
    ['POST', '/v1/me/deletion/cancel'],
  ] as const) {
    const fresh = poisoned().idem;
    const got = await outcome(() =>
      fresh.execute(request({ method: method as 'POST', path }), () =>
        Promise.resolve(result(0, 200)),
      ),
    );
    expect(got).toEqual(
      method === 'GET' ? { error: 'IdempotencyError invalid_request' } : POISONED,
    );
  }
});

it('[规划/04 §5「幂等」] 请求本身有编程错误（appId 空、method 非 POST/PUT/PATCH/DELETE、path 不以 / 开头或带查询串与片段、请求体不是 JSON 值）→ IdempotencyError invalid_request；主体无效 → invalid_subject；都不碰数据库', async () => {
  const cases: [Parameters<typeof request>[0], string][] = [
    [{ appId: '' }, 'IdempotencyError invalid_request'],
    [{ method: 'GET' as 'POST' }, 'IdempotencyError invalid_request'],
    [{ method: 'post' as 'POST' }, 'IdempotencyError invalid_request'],
    [{ path: 'v1/links/x/open' }, 'IdempotencyError invalid_request'],
    [{ path: '' }, 'IdempotencyError invalid_request'],
    [{ path: '/v1/links/x/open?a=1' }, 'IdempotencyError invalid_request'],
    [{ path: '/v1/links/x/open#f' }, 'IdempotencyError invalid_request'],
    [{ body: { a: undefined } }, 'IdempotencyError invalid_request'],
    [{ body: { a: 1n } }, 'IdempotencyError invalid_request'],
    [
      { actor: { userId: null, deviceId: null, phoneHmac: null } },
      'IdempotencyError invalid_subject',
    ],
    [
      { actor: { userId: 'u1', deviceId: null, phoneHmac: null } },
      'IdempotencyError invalid_subject',
    ],
  ];
  for (const [overrides, expected] of cases) {
    const { idem } = poisoned();
    let calls = 0;
    const got = await outcome(() =>
      idem.execute(request(overrides), () => {
        calls += 1;
        return Promise.resolve(result(0, 200));
      }),
    );
    expect(got).toEqual({ error: expected });
    expect(calls).toBe(0);
  }
  for (const [overrides, expected] of cases) {
    const { idem } = poisoned();
    const got = await outcome(() =>
      idem.executeInTransaction(sensitiveRequest('account_deletion', overrides), () =>
        Promise.resolve(result(0, 200)),
      ),
    );
    expect(got).toEqual({ error: expected });
  }
});

it('[BR-ID-30 ⑤ 处理中租约（待编排会话确认）] processingLeaseMs 只接受 1000～600000 的整数（缺省 60000）；越界、小数、NaN、非数字 → IdempotencyError invalid_option；创建时不碰数据库与时钟', () => {
  const clockTouched: string[] = [];
  const clock = {
    now(): Date {
      clockTouched.push('now');
      return new Date(0);
    },
  };
  const { logger } = recordingLogger();
  for (const lease of [1000, 600_000, 60_000, 1001, undefined]) {
    const got = outcomeSync(() =>
      createIdempotency(
        lease === undefined
          ? { db: poisonDb(), clock, logger }
          : { db: poisonDb(), clock, logger, processingLeaseMs: lease },
      ),
    );
    expect(typeof got === 'object' && got !== null && !('error' in got)).toBe(true);
  }
  for (const lease of [
    999,
    600_001,
    0,
    -1,
    1000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '60000',
  ]) {
    expect(
      outcomeSync(() =>
        createIdempotency({ db: poisonDb(), clock, logger, processingLeaseMs: lease as number }),
      ),
    ).toEqual({ error: 'IdempotencyError invalid_option' });
  }
  let caught: unknown;
  try {
    createIdempotency({ db: poisonDb(), clock, logger, processingLeaseMs: 0 });
  } catch (error) {
    caught = error;
  }
  expect(idempotencyErrorProblems(caught, 'invalid_option', MESSAGES.invalid_option)).toEqual([]);
  expect(clockTouched).toEqual([]);
});

it('[规划/04 §6.1 作废接口] 作废原语的输入：action 不是四个之一、键格式不符 → 20001（HTTP 400，data.fields 按 action、idempotency_key 的顺序列出），不碰数据库；userId 无效 → invalid_subject', async () => {
  const body = (fields: string) =>
    `{"code":20001,"msg":"invalid abandon request","data":{"fields":[${fields}]},"trace_id":"${TRACE}"}`;
  const cases: [string, string, string][] = [
    ['open_link', 'abcdefgh', '"action"'],
    ['', 'abcdefgh', '"action"'],
    ['WITHDRAW', 'abcdefgh', '"action"'],
    ['withdraw', 'short', '"idempotency_key"'],
    ['withdraw', 'a'.repeat(65), '"idempotency_key"'],
    ['phone_change', 'bad key!', '"idempotency_key"'],
    ['delete', '', '"action","idempotency_key"'],
  ];
  for (const [action, key, fields] of cases) {
    const { idem } = poisoned();
    expect(
      await outcome(() =>
        idem.abandon({ appId: 'couli', userId: USER_A, action, key, traceId: TRACE }),
      ),
    ).toStrictEqual({ status: 400, body: body(fields), source: 'idempotency' });
  }
  for (const action of ACTIONS) {
    const { idem } = poisoned();
    expect(
      await outcome(() =>
        idem.abandon({ appId: 'couli', userId: USER_A, action, key: 'abcdefgh', traceId: TRACE }),
      ),
    ).toEqual(POISONED);
  }
  for (const userId of ['', USER_A.toUpperCase(), 'u1', DEVICE_A.slice(1)]) {
    const { idem } = poisoned();
    expect(
      await outcome(() =>
        idem.abandon({
          appId: 'couli',
          userId,
          action: 'withdraw',
          key: 'abcdefgh',
          traceId: TRACE,
        }),
      ),
    ).toEqual({ error: 'IdempotencyError invalid_subject' });
  }
  expect(Object.keys(SENSITIVE)).toEqual(ACTIONS);
});
