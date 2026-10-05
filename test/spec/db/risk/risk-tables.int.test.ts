// B1-03a, SPEC_REF 1955639: schema-level rules only (04 §3.2, BR-ID-31/36, BR-ATTR-26).
// API idempotent responses, state transitions, notifications, deadlines computed from the
// statutory calendar and order matching are later module tests, not migration assertions.
// Every case checks its tables/columns before creating fixtures. No database work in beforeAll
// except obtaining the business-role connection to the per-file template clone.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ACTIONS,
  BLOCKLIST_EXPIRES_AT,
  CHECK_ERRORS,
  TABLES,
  allowedValues,
  appealRow,
  columns,
  conditionColumn,
  contractValues,
  fixtureValue,
  hasPrivilege,
  hmacValue,
  hitColumn,
  hitRow,
  insertRow,
  newUser,
  phoneColumn,
  primaryKey,
  ready,
  sqlState,
  useDb,
  type Table,
} from './kit.ts';

let database: TestDatabase | undefined;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

type Shape = Record<string, readonly [readonly string[], boolean?]>;
const TEXT = ['text', 'varchar', 'bpchar'];
const STRING = [...TEXT, 'enum'];
const ID = ['uuid', ...TEXT];
const HASH = [...TEXT, 'bytea'];
const TIME = ['timestamptz'];

async function shape(table: Table, expected: Shape): Promise<void> {
  const list = await columns(table);
  for (const [name, [types, nullable]] of Object.entries(expected)) {
    const col = list.find((c) => c.name === name);
    expect(col, `${table}.${name}`).toBeDefined();
    expect(types, `${table}.${name} type`).toContain(col?.category === 'E' ? 'enum' : col?.type);
    if (nullable !== undefined) expect(col?.nullable, `${table}.${name} nullable`).toBe(nullable);
  }
}

async function common(table: Table): Promise<void> {
  await shape(table, { app_id: [TEXT, false], created_at: [TIME, false] });
  if (table !== 'risk_hits') await shape(table, { updated_at: [TIME, false] });
  if (table !== 'risk_hits' && table !== 'user_risk_state') {
    await shape(table, { id: [['uuid'], false], updated_at: [TIME, false] });
    expect(await primaryKey(table), `${table} entity key`).toEqual(['id']);
  }
}

async function closeAppeal(row: Record<string, unknown>, status: string): Promise<void> {
  // Handler may be a text system actor or an FK; let the local catalog filler supply it.
  // No transition() exists in this migration task: SQL exercises only the partial indexes.
  const result = await sql`
    UPDATE app.appeals SET status = ${status}, closed_at = now(),
      handler_id = ${await fixtureValue('appeals', 'handler_id')}
    WHERE id = ${row['id']}
  `.execute(app);
  expect(result.numAffectedRows).toBe(1n);
}

it('[AC-B1-03a#1] blocklist 表与列 [04 §3.2 blocklist]', async () => {
  await ready('blocklist');
  await common('blocklist');
  await shape('blocklist', {
    dimension: [STRING, false],
    value_hmac: [HASH],
    violation_type: [STRING, false],
    reason: [TEXT],
    created_by: [ID, false],
    expire_at: [TIME, true],
    platform: [STRING],
    union_account_id: [['uuid']],
    start_at: [TIME],
    end_at: [TIME, true],
    status: [STRING, false],
  });
});

it('[AC-B1-03a#2] user_risk_state 表与用户主键 [04 §3.2 user_risk_state]', async () => {
  await ready('user_risk_state');
  await common('user_risk_state');
  await shape('user_risk_state', {
    user_id: [['uuid'], false],
    state: [STRING, false],
    reason: [TEXT],
    reason_category: [STRING],
    frozen_until: [TIME, true],
    changed_by: [ID],
    changed_at: [TIME, false],
  });
  expect(await primaryKey('user_risk_state')).toEqual(['user_id']);
});

it('[AC-B1-03a#3] appeals 表与条件可空列 [04 §3.2 appeals]', async () => {
  await ready('appeals');
  await common('appeals');
  await shape('appeals', {
    user_id: [['uuid'], true],
    target_type: [STRING, false],
    request_type: [STRING, true],
    target_id: [ID, false],
    prev_risk_state: [STRING, true],
    status: [STRING, false],
    content: [TEXT, false],
    deadline_at: [TIME, false],
    handler_id: [ID, true],
    closed_at: [TIME, true],
    [await phoneColumn('appeals')]: [HASH, true],
  });
  const names = (await columns('appeals')).map((c) => c.name);
  expect(names.filter((n) => /phone|mobile/.test(n) && !/hmac|mask/.test(n))).toEqual([]);
});

it('[AC-B1-03a#4] risk_rules 表与条件 JSON [04 §3.2 risk_rules]', async () => {
  await ready('risk_rules');
  await common('risk_rules');
  await shape('risk_rules', {
    rule_id: [ID, false],
    scene: [STRING, false],
    risk_action: [STRING, false],
    status: [STRING, false],
    version: [['int2', 'int4', 'int8'], false],
    [await conditionColumn()]: [['json', 'jsonb'], false],
  });
});

it('[AC-B1-03a#5] risk_hits 表与拦截请求字段 [04 §3.2 risk_hits]', async () => {
  await ready('risk_hits');
  await common('risk_hits');
  await shape('risk_hits', {
    user_id: [['uuid'], true],
    rule_id: [ID, false],
    risk_action: [STRING, false],
    ref_type: [STRING, false],
    ref_id: [ID, false],
    request_type: [STRING, true],
    amount_fen: [['int8'], true],
    [await hitColumn('dimension')]: [STRING, false],
    [await hitColumn('hmac')]: [HASH, false],
    [await phoneColumn('risk_hits')]: [HASH, true],
    [await phoneColumn('risk_hits', 'masked')]: [TEXT, true],
  });
  const names = (await columns('risk_hits')).map((c) => c.name);
  expect(names.filter((n) => /phone|mobile/.test(n) && !/hmac|mask/.test(n))).toEqual([]);
});

it('[AC-B1-03a#6] 申诉单列枚举与契约一致 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const [column, contract] of [
    ['target_type', 'appeal_target_type'],
    ['request_type', 'blocked_request_type'],
    ['status', 'appeal_status'],
  ] as const) {
    expect(await allowedValues('appeals', column), column).toEqual(contractValues(contract).sort());
  }
});

it('[AC-B1-03a#7] 风控状态单列枚举与契约一致 [BR-ID-31]', async () => {
  await ready('user_risk_state');
  expect(await allowedValues('user_risk_state', 'state')).toEqual(
    contractValues('risk_state').sort(),
  );
});

it('[AC-B1-03a#8] 风控动作与请求类型单列集合 [BR-ID-36]', async () => {
  await ready('risk_rules', 'risk_hits');
  for (const table of ['risk_rules', 'risk_hits']) {
    expect(await allowedValues(table, 'risk_action'), table).toEqual([...ACTIONS].sort());
  }
  expect(await allowedValues('risk_hits', 'request_type')).toEqual(
    contractValues('blocked_request_type').sort(),
  );
});

it('[AC-B1-03a#9] 黑名单覆盖全部账号与订单维度 [BR-ID-31] [BR-ATTR-26]', async () => {
  await ready('blocklist');
  // No blocklist enum in contracts at SPEC_REF. BR-ID-31 counts five account dimensions:
  // payout accounts may share one dimension or split into Alipay, bank card and WeChat.
  const actual = await allowedValues('blocklist', 'dimension');
  const payoutGroups = actual.includes('payout_account')
    ? [['payout_account']]
    : [
        ['alipay', 'alipay_hmac'],
        ['bank_card', 'bank_card_hmac'],
        ['wechat_openid', 'wechat', 'wechat_openid_hmac'],
      ];
  const groups = [
    ['phone', 'phone_hmac'],
    ['id_no', 'id_no_hmac'],
    ...payoutGroups,
    ['device', 'device_hash'],
    ['relation_id'],
    ['order_no_suffix'],
    ['channel'],
  ];
  for (const alternatives of groups) {
    expect(
      actual.filter((v) => alternatives.includes(v)),
      alternatives.join('/'),
    ).toHaveLength(1);
  }
  expect(actual.filter((v) => !groups.flat().includes(v))).toEqual([]);
  expect(await allowedValues('blocklist', 'violation_type')).toEqual([
    'fraud_invite',
    'malicious_rights',
    'other',
  ]);
  expect(await allowedValues('blocklist', 'status')).toEqual(['active', 'inactive']);
});

it('[AC-B1-03a#10] request_type 仅被拦请求必填 [04 §3.2 appeals]', async () => {
  await ready('appeals');
  for (const target of ['account', 'order']) {
    const row = await appealRow(target);
    expect(await sqlState(insertRow('appeals', row)), target).toBe('no error');
    for (const request of contractValues('blocked_request_type')) {
      const invalidRow = await appealRow(target);
      expect(CHECK_ERRORS).toContain(
        await sqlState(
          insertRow('appeals', {
            ...invalidRow,
            request_type: request,
          }),
        ),
      );
    }
  }
  for (const request of contractValues('blocked_request_type')) {
    const row = await appealRow('blocked_request', request);
    expect(await sqlState(insertRow('appeals', row)), request).toBe('no error');
    expect(CHECK_ERRORS).toContain(
      await sqlState(
        insertRow('appeals', {
          ...row,
          id: randomUUID(),
          target_id: randomUUID(),
          request_type: null,
        }),
      ),
    );
  }
});

it('[AC-B1-03a#11] 仅注册拦截申诉允许没有用户 [BR-ID-36]', async () => {
  await ready('appeals');
  expect(await sqlState(insertRow('appeals', await appealRow('blocked_request', 'register')))).toBe(
    'no error',
  );
  for (const target of ['account', 'order', 'blocked_request']) {
    for (const request of target === 'blocked_request'
      ? ['withdraw', 'phone_change', 'payout_account']
      : [null]) {
      const row = await appealRow(target, request);
      expect(await sqlState(insertRow('appeals', row)), `${target}/${request}`).toBe('no error');
      expect(CHECK_ERRORS).toContain(
        await sqlState(
          insertRow('appeals', {
            ...row,
            id: randomUUID(),
            target_id: randomUUID(),
            user_id: null,
          }),
        ),
      );
    }
  }
});

it('[AC-B1-03a#12] 账户保存原状态且订单与请求不保存 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const previous of ['banned', 'frozen']) {
    expect(
      await sqlState(
        insertRow('appeals', {
          ...(await appealRow('account')),
          prev_risk_state: previous,
        }),
      ),
    ).toBe('no error');
  }
  for (const previous of [null, 'normal', 'appealing']) {
    expect(CHECK_ERRORS).toContain(
      await sqlState(
        insertRow('appeals', {
          ...(await appealRow('account')),
          prev_risk_state: previous,
        }),
      ),
    );
  }
  for (const [target, request] of [
    ['order', null],
    ['blocked_request', 'register'],
  ] as const) {
    const row = await appealRow(target, request);
    expect(await sqlState(insertRow('appeals', row))).toBe('no error');
    for (const previous of ['banned', 'frozen']) {
      expect(CHECK_ERRORS).toContain(
        await sqlState(
          insertRow('appeals', {
            ...row,
            id: randomUUID(),
            target_id: randomUUID(),
            prev_risk_state: previous,
            [await phoneColumn('appeals')]:
              target === 'blocked_request'
                ? await hmacValue('appeals', await phoneColumn('appeals'))
                : null,
          }),
        ),
      );
    }
  }
});

it('[AC-B1-03a#13] 同一对象最多一条处理中 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const [target, request] of [
    ['account', null],
    ['order', null],
    ['blocked_request', 'withdraw'],
  ] as const) {
    const row = await appealRow(target, request);
    await insertRow('appeals', row);
    expect(await sqlState(insertRow('appeals', { ...row, id: randomUUID() })), target).toBe(
      '23505',
    );
  }
});

it('[AC-B1-03a#14] 同用户不同对象及同编号不同类型可并存 [BR-ID-36]', async () => {
  await ready('appeals');
  const account = await appealRow('account');
  await insertRow('appeals', account);
  const order = {
    ...(await appealRow('order')),
    user_id: account['user_id'],
    target_id: account['target_id'],
  };
  expect(await sqlState(insertRow('appeals', order))).toBe('no error');
  expect(
    await sqlState(insertRow('appeals', { ...order, id: randomUUID(), target_id: randomUUID() })),
  ).toBe('no error');
});

it('[AC-B1-03a#15] 维持或撤销后释放对象处理中名额 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const status of ['upheld', 'revoked']) {
    for (const [target, request] of [
      ['account', null],
      ['order', null],
      ['blocked_request', 'withdraw'],
    ] as const) {
      const row = await appealRow(target, request);
      await insertRow('appeals', row);
      await closeAppeal(row, status);
      const second = { ...row, id: randomUUID() };
      expect(await sqlState(insertRow('appeals', second)), `${target}/${status}`).toBe('no error');
      await closeAppeal(second, status);
      expect(await sqlState(insertRow('appeals', { ...row, id: randomUUID() }))).toBe('no error');
    }
  }
});

it('[AC-B1-03a#16] 对象幂等由含租户的部分唯一索引保障 [04 §3.2 appeals]', async () => {
  await ready('appeals');
  const result = await sql<{ keys: string[]; predicate: string }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class r ON r.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'app' AND r.relname = 'appeals' AND i.indisunique
      AND i.indisvalid AND i.indpred IS NOT NULL
  `.execute(app);
  expect(
    result.rows.some(
      (r) =>
        r.keys.length === 3 &&
        r.keys[0] === 'app_id' &&
        r.keys.includes('target_type') &&
        r.keys.includes('target_id') &&
        /processing/.test(r.predicate),
    ),
    JSON.stringify(result.rows),
  ).toBe(true);
});

it('[AC-B1-03a#17] 注册类跨请求按手机号限制处理中 [BR-ID-36]', async () => {
  await ready('appeals');
  const row = await appealRow('blocked_request', 'register');
  await insertRow('appeals', row);
  expect(
    await sqlState(insertRow('appeals', { ...row, id: randomUUID(), target_id: randomUUID() })),
  ).toBe('23505');
  expect(
    await sqlState(
      insertRow('appeals', {
        ...row,
        id: randomUUID(),
        target_id: randomUUID(),
        [await phoneColumn('appeals')]: await hmacValue('appeals', await phoneColumn('appeals')),
      }),
    ),
  ).toBe('no error');
  expect(CHECK_ERRORS).toContain(
    await sqlState(
      insertRow('appeals', {
        ...row,
        id: randomUUID(),
        target_id: randomUUID(),
        [await phoneColumn('appeals')]: null,
      }),
    ),
  );
});

it('[AC-B1-03a#18] 手机号额外限制不扩展到其他请求类型 [BR-ID-36]', async () => {
  await ready('appeals');
  const phone = await phoneColumn('appeals');
  const registered = await appealRow('blocked_request', 'register');
  await insertRow('appeals', registered);
  for (const request of ['withdraw', 'phone_change', 'payout_account']) {
    const row = { ...(await appealRow('blocked_request', request)), [phone]: registered[phone] };
    expect(await sqlState(insertRow('appeals', row)), request).toBe('no error');
    expect(
      await sqlState(insertRow('appeals', { ...row, id: randomUUID(), target_id: randomUUID() })),
    ).toBe('no error');
  }
});

it('[AC-B1-03a#19] 注册结案后释放手机号处理中名额 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const status of ['upheld', 'revoked']) {
    const row = await appealRow('blocked_request', 'register');
    await insertRow('appeals', row);
    await closeAppeal(row, status);
    expect(
      await sqlState(insertRow('appeals', { ...row, id: randomUUID(), target_id: randomUUID() })),
    ).toBe('no error');
  }
});

it('[AC-B1-03a#20] 并发登记对象与注册手机号只成功一次 [BR-ID-36]', async () => {
  await ready('appeals');
  for (const phoneKey of [false, true]) {
    const row = await appealRow('blocked_request', phoneKey ? 'register' : 'withdraw');
    const attempts = await Promise.all([
      sqlState(insertRow('appeals', row)),
      sqlState(
        insertRow('appeals', {
          ...row,
          id: randomUUID(),
          target_id: phoneKey ? randomUUID() : row['target_id'],
        }),
      ),
    ]);
    expect(attempts.sort(), phoneKey ? 'phone key' : 'object key').toEqual(['23505', 'no error']);
  }
});

it('[AC-B1-03a#21] 被拦请求命中记录完整保存且金额为 bigint 分 [BR-ID-36]', async () => {
  await ready('risk_rules', 'risk_hits');
  for (const request of contractValues('blocked_request_type')) {
    const row = await hitRow(request);
    const stored = await insertRow('risk_hits', row);
    for (const name of [
      'request_type',
      'user_id',
      'ref_type',
      'ref_id',
      'amount_fen',
      await phoneColumn('risk_hits'),
      await phoneColumn('risk_hits', 'masked'),
    ]) {
      expect(stored[name], `${request}/${name}`).toEqual(row[name]);
    }
    if (request === 'withdraw') expect(typeof stored['amount_fen']).toBe('bigint');
  }
});

it('[AC-B1-03a#22] risk_hits 业务角色不可更新或删除 [BR-ID-36]', async () => {
  await ready('risk_rules', 'risk_hits');
  const row = await hitRow();
  await insertRow('risk_hits', row);
  expect(
    await sqlState(
      sql`UPDATE app.risk_hits SET risk_action = 'pass' WHERE ref_id = ${row['ref_id']}`.execute(
        app,
      ),
    ),
  ).toBe('42501');
  expect(
    await sqlState(sql`DELETE FROM app.risk_hits WHERE ref_id = ${row['ref_id']}`.execute(app)),
  ).toBe('42501');
  const remaining = await sql<{
    risk_action: string;
  }>`SELECT risk_action FROM app.risk_hits WHERE ref_id = ${row['ref_id']}`.execute(app);
  expect(remaining.rows).toEqual([{ risk_action: 'block' }]);
});

it('[AC-B1-03a#23] 账号黑名单只存 HMAC 并记到期时间 [BR-ID-31] [BR-ID-30]', async () => {
  await ready('blocklist');
  const dimension = (await allowedValues('blocklist', 'dimension')).find((v) =>
    ['phone', 'phone_hmac'].includes(v),
  );
  expect(dimension).toBeDefined();
  const hmac = await hmacValue('blocklist', 'value_hmac');
  const row = await insertRow('blocklist', {
    app_id: 'couli',
    dimension,
    value_hmac: hmac,
    violation_type: 'other',
    reason: '风控登记',
    status: 'active',
    expire_at: BLOCKLIST_EXPIRES_AT,
  });
  expect(row['value_hmac']).toEqual(hmac);
  expect(row['expire_at']).toEqual(BLOCKLIST_EXPIRES_AT);
  expect(CHECK_ERRORS).toContain(
    await sqlState(
      insertRow('blocklist', {
        app_id: 'couli',
        dimension,
        value_hmac: null,
        violation_type: 'other',
        reason: '风控登记',
        status: 'active',
        expire_at: BLOCKLIST_EXPIRES_AT,
      }),
    ),
  );
  // 04 explicitly leaves ORDER-side value storage to the migration. Do not forbid that
  // column globally. Account values must not be stored there; duplicate policy is unspecified.
  const rawColumns = (await columns('blocklist')).filter((c) =>
    [
      'value',
      'raw_value',
      'value_plaintext',
      'phone',
      'phone_number',
      'id_no',
      'alipay_account',
      'bank_card_no',
      'wechat_openid',
      'relation_id',
    ].includes(c.name),
  );
  for (const col of rawColumns) {
    expect(row[col.name], `account plaintext ${col.name}`).toBeNull();
    expect(CHECK_ERRORS).toContain(
      await sqlState(
        insertRow('blocklist', {
          app_id: 'couli',
          dimension,
          value_hmac: await hmacValue('blocklist', 'value_hmac'),
          violation_type: 'other',
          reason: '风控登记',
          status: 'active',
          expire_at: BLOCKLIST_EXPIRES_AT,
          [col.name]: '13800000000',
        }),
      ),
    );
  }
});

it('[AC-B1-03a#24] 冻结可定期或不定期且每用户仅一行 [BR-ID-36]', async () => {
  await ready('user_risk_state');
  for (const until of [null, new Date('2026-11-05T02:00:00Z')]) {
    const user = await newUser();
    const values = {
      app_id: 'couli',
      user_id: user,
      state: 'frozen',
      frozen_until: until,
      reason: await fixtureValue('user_risk_state', 'reason'),
      reason_category: await fixtureValue('user_risk_state', 'reason_category'),
    };
    const row = await insertRow('user_risk_state', values);
    expect(row['frozen_until']).toEqual(until);
    expect(await sqlState(insertRow('user_risk_state', values))).toBe('23505');
  }
});

it('[AC-B1-03a#25] 永久封禁不设到期时间 [BR-ID-31]', async () => {
  await ready('user_risk_state');
  expect(
    await sqlState(
      insertRow('user_risk_state', {
        app_id: 'couli',
        user_id: await newUser(),
        state: 'banned',
        frozen_until: null,
        reason: await fixtureValue('user_risk_state', 'reason'),
        reason_category: await fixtureValue('user_risk_state', 'reason_category'),
      }),
    ),
  ).toBe('no error');
  expect(CHECK_ERRORS).toContain(
    await sqlState(
      insertRow('user_risk_state', {
        app_id: 'couli',
        user_id: await newUser(),
        state: 'banned',
        frozen_until: new Date('2026-11-05T02:00:00Z'),
        reason: await fixtureValue('user_risk_state', 'reason'),
        reason_category: await fixtureValue('user_risk_state', 'reason_category'),
      }),
    ),
  );
});

it('[AC-B1-03a#26] risk 写者有读写权限且命中表只追加 [04 §3.2]', async () => {
  await ready(...TABLES);
  for (const table of TABLES) {
    for (const privilege of ['SELECT', 'INSERT'])
      expect(await hasPrivilege('couli_app', table, privilege), `${table}/${privilege}`).toBe(true);
    expect(await hasPrivilege('couli_app', table, 'UPDATE'), table).toBe(table !== 'risk_hits');
  }
  expect(await hasPrivilege('couli_app', 'risk_hits', 'DELETE')).toBe(false);
  expect(await hasPrivilege('couli_app', 'risk_hits', 'TRUNCATE')).toBe(false);
});

it('[AC-B1-03a#27] readonly 只读、maint 无权限、payout 仅用风控状态表 [04 §3.2] [ADR-0001 §4.2] [BR-WDR-13 ③]', async () => {
  await ready(...TABLES);
  for (const table of TABLES) {
    expect(await hasPrivilege('couli_readonly', table, 'SELECT'), table).toBe(true);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(await hasPrivilege('couli_readonly', table, privilege), `${table}/${privilege}`).toBe(
        false,
      );
    }
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      expect(await hasPrivilege('couli_maint', table, privilege), `${table}/${privilege}`).toBe(
        false,
      );
      if (table !== 'user_risk_state') {
        expect(
          await hasPrivilege('couli_payout', table, privilege),
          `payout/${table}/${privilege}`,
        ).toBe(false);
      }
    }
  }
});

it('[AC-B1-03a#28] payout 可读风控状态用于发款前复核 [BR-WDR-13 ③] [BR-WDR-05]', async () => {
  await ready('user_risk_state');
  // BR-WDR-13 ③ requires checking risk_state against the BR-WDR-05 withdrawal blocks;
  // reading frozen_until is not required for this check.
  for (const column of ['user_id', 'app_id', 'state']) {
    const result = await sql<{ ok: boolean }>`
      SELECT has_column_privilege('couli_payout', 'app.user_risk_state', ${column}, 'SELECT') AS ok
    `.execute(app);
    expect(result.rows[0]?.ok, column).toBe(true);
  }
  for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    expect(await hasPrivilege('couli_payout', 'user_risk_state', privilege), privilege).toBe(false);
  }
});

it('[AC-B1-03a#29] 申诉对象与手机号唯一性按 app_id 隔离 [04 §3.2 appeals]', async () => {
  await ready('appeals');
  const row = await appealRow('blocked_request', 'register');
  await insertRow('appeals', row);
  expect(
    await sqlState(
      insertRow('appeals', {
        ...row,
        id: randomUUID(),
        app_id: 'couli_two',
      }),
    ),
  ).toBe('no error');
});

it('[AC-B1-03a#30] 四种风控动作可写且未知动作被拒 [BR-ID-36]', async () => {
  await ready('risk_rules', 'risk_hits');
  for (const action of ACTIONS) {
    expect(
      await sqlState(
        insertRow('risk_rules', {
          app_id: 'couli',
          risk_action: action,
        }),
      ),
      action,
    ).toBe('no error');
    const row = await hitRow('withdraw');
    // Non-blocked events still record their order reference and HMAC, without request PII.
    if (action !== 'block') {
      row['ref_type'] = 'order';
      row['request_type'] = null;
      row['amount_fen'] = null;
      row[await phoneColumn('risk_hits')] = null;
      row[await phoneColumn('risk_hits', 'masked')] = null;
    }
    row['risk_action'] = action;
    expect(await sqlState(insertRow('risk_hits', row)), action).toBe('no error');
  }
  expect(CHECK_ERRORS).toContain(
    await sqlState(
      insertRow('risk_rules', {
        app_id: 'couli',
        risk_action: 'unknown_action',
      }),
    ),
  );
  expect(CHECK_ERRORS).toContain(
    await sqlState(
      insertRow('risk_hits', {
        ...(await hitRow()),
        risk_action: 'unknown_action',
      }),
    ),
  );
});
