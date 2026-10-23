// Unit tests of the console's member edit (B1-27b) over a recording Kysely driver: the order of the
// checks, what reaches the review, and the statements of a save inside one transaction. The SQL
// itself runs against PostgreSQL in the rule tests (test/spec/identity/admin-profile).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type FieldCrypto } from '../../platform/index.ts';
import type { NicknameReviewInput, NicknameReviewVerdict } from '../ports/nickname-review.ts';
import { AdminProfileEdit, type AdminProfileEditCommand } from './admin-profile-edit.ts';

const APP = 'b1-27b-unit';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';
const OLD_PHONE = '19900000001';
const NEW_PHONE = '19900000002';
const NOW = '2026-10-20T02:00:00.000Z';

interface Options {
  user?: { phone: string | null; nickname: string } | null;
  holder?: boolean;
  blocked?: boolean;
  verdict?: () => Promise<NicknameReviewVerdict>;
  conflict?: boolean;
  auditFails?: boolean;
  /** The current nickname of each successive users read (then `user.nickname`). */
  nicknames?: string[];
}

function setup(options: Options = {}) {
  const events: string[] = [];
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const user = options.user === undefined ? { phone: OLD_PHONE, nickname: '旧名' } : options.user;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push({ sql: compiled.sql, parameters: compiled.parameters });
      const label = /^(?:update "app"\."\w+"|insert into "app"\."\w+"|select)/.exec(compiled.sql);
      events.push(label?.[0] ?? compiled.sql);
      const sql = compiled.sql;
      if (sql.startsWith('update "app"."users"') && options.conflict === true) {
        return Promise.reject(
          Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'users_phone_hmac_key',
          }),
        );
      }
      let rows: unknown[] = [];
      if (sql.startsWith('select "phone_hmac"') && user !== null) {
        rows = [
          {
            phone_hmac: user.phone === null ? null : `hmac(${user.phone})`,
            phone_cipher: user.phone === null ? null : Buffer.from(`enc(${user.phone})`),
            nickname: options.nicknames?.shift() ?? user.nickname,
            row_version: 3,
          },
        ];
      } else if (sql.startsWith('select "id" from "app"."users"') && options.holder === true) {
        rows = [{ id: 'other' }];
      }
      return Promise.resolve({ rows, numAffectedRows: 1n } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const crypto = {
    blindIndex: (value: string) => `hmac(${value})`,
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
  } as unknown as FieldCrypto;
  const reviews: NicknameReviewInput[] = [];
  const blocklistCalls: unknown[] = [];
  const revocations: unknown[] = [];
  const audits: AuditInput[] = [];
  const service = new AdminProfileEdit({
    db,
    clock: new FixedClock(NOW),
    logger: { info: () => undefined, warn: () => undefined },
    crypto,
    review: {
      review: (input) => {
        reviews.push(input);
        return options.verdict === undefined ? Promise.resolve('pass') : options.verdict();
      },
    },
    blocklist: {
      matchRegistration: (_trx, input) => {
        blocklistCalls.push(input);
        return Promise.resolve(
          options.blocked === true
            ? { code: 44001, data: { risk_msg_code: 'blocklist.other' }, hits: [] }
            : null,
        );
      },
    },
    auditOn: () => ({
      append: (input) => {
        if (options.auditFails === true) return Promise.reject(new Error('audit down'));
        audits.push(input);
        events.push('audit');
        return Promise.resolve();
      },
    }),
    revokeSessions: (_trx, input) => {
      revocations.push(input);
      events.push('revoke');
      return Promise.resolve(['sid-1']);
    },
  });
  const command = (body: AdminProfileEditCommand['body'], userId = USER) => ({
    appId: APP,
    adminId: ADMIN,
    ip: '127.0.0.1',
    userId,
    body,
  });
  return { service, command, events, statements, reviews, blocklistCalls, revocations, audits };
}

const REASON = '企业微信核对注册时间';

it('[AC-B1-27b#8] 非 UUID 的 user_id 不查库即 20001 [user_id]；查无此人同样 20001 [user_id]', async () => {
  const first = setup();
  expect(
    await first.service.edit(first.command({ nickname: '小狸', reason: REASON }, 'x')),
  ).toEqual({ code: 20001, data: { fields: ['user_id'] } });
  expect(first.statements).toEqual([]);
  const missing = setup({ user: null });
  expect(await missing.service.edit(missing.command({ nickname: '小狸', reason: REASON }))).toEqual(
    { code: 20001, data: { fields: ['user_id'] } },
  );
  expect(missing.reviews).toEqual([]);
});

it('[AC-B1-27b#18] 规范化不通过 → phone_invalid，不查名单、不送审、不写', async () => {
  const s = setup();
  const result = await s.service.edit(
    s.command({ phone: '12345', nickname: '小狸', reason: REASON }),
  );
  expect(result).toEqual({ code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } });
  expect(s.blocklistCalls).toEqual([]);
  expect(s.reviews).toEqual([]);
  expect(s.events).not.toContain('begin');
});

it('[AC-B1-27b#29] 昵称去空白后为空或超过 16 个字素 → 20001 [nickname]，不送审', async () => {
  for (const nickname of ['  ', '狸'.repeat(17)]) {
    const s = setup();
    expect(await s.service.edit(s.command({ nickname, reason: REASON }))).toEqual({
      code: 20001,
      data: { fields: ['nickname'] },
    });
    expect(s.reviews).toEqual([]);
  }
});

it('[AC-B1-27b#20] 名单命中先于占用：44001 不带 data，不送审；未命中而被占用为 30411', async () => {
  const listed = setup({ blocked: true, holder: true });
  expect(
    await listed.service.edit(
      listed.command({ phone: NEW_PHONE, nickname: '小狸', reason: REASON }),
    ),
  ).toEqual({ code: 44001 });
  expect(listed.reviews).toEqual([]);
  expect(listed.blocklistCalls).toEqual([
    { app_id: APP, phone_hmac: `hmac(${NEW_PHONE})`, related_phone: NEW_PHONE },
  ]);
  const held = setup({ holder: true });
  expect(await held.service.edit(held.command({ phone: NEW_PHONE, reason: REASON }))).toEqual({
    code: 30411,
  });
  expect(held.events.some((event) => event.startsWith('update'))).toBe(false);
});

it('[AC-B1-27b#40] 审核抛错或不可用一律 nickname_sensitive，送审的是去空白后的昵称', async () => {
  for (const verdict of [
    () => Promise.reject(new Error('outage')),
    () => Promise.resolve('unavailable' as const),
    () => Promise.resolve('hit' as const),
  ]) {
    const s = setup({ verdict });
    expect(await s.service.edit(s.command({ nickname: ' 小狸 ', reason: REASON }))).toEqual({
      code: 20001,
      data: { fields: ['nickname'], reason: 'nickname_sensitive' },
    });
    expect(s.reviews).toEqual([{ appId: APP, text: '小狸' }]);
    expect(s.events.some((event) => event.startsWith('update'))).toBe(false);
  }
});

it('[AC-B1-27b#32] 改号加改昵称：同一事务里改用户、写旧号 deleted_identities、作废会话、写一条脱敏审计', async () => {
  const s = setup();
  const body = { phone: `+86 ${NEW_PHONE}`, nickname: '小狸', reason: REASON };
  expect(await s.service.edit(s.command(body))).toEqual({ code: 0 });
  const begin = s.events.lastIndexOf('begin');
  const tail = s.events.slice(begin);
  expect(tail[0]).toBe('begin');
  expect(tail.at(-1)).toBe('commit');
  const order = [
    'update "app"."users"',
    'insert into "app"."deleted_identities"',
    'revoke',
    'audit',
  ];
  const positions = order.map((event) => tail.indexOf(event));
  expect(positions.every((position) => position > 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  const insert = s.statements.find((x) =>
    x.sql.startsWith('insert into "app"."deleted_identities"'),
  );
  expect(insert?.parameters).toContain(`hmac(${OLD_PHONE})`);
  expect(insert?.parameters).toContain('phone_changed');
  expect(s.revocations).toEqual([{ app_id: APP, user_id: USER, reason: 'phone_changed' }]);
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]).toMatchObject({
    appId: APP,
    actor: ADMIN,
    action: 'user_profile_edit',
    target: USER,
    ip: '127.0.0.1',
    before: { phone_masked: '199****0001', nickname: '旧名' },
    after: {
      user_id: USER,
      reason: REASON,
      fields: ['phone', 'nickname'],
      phone_masked: '199****0002',
      nickname: '小狸',
    },
  });
  expect(JSON.stringify(s.audits[0])).not.toContain(OLD_PHONE);
  expect(JSON.stringify(s.audits[0])).not.toContain(NEW_PHONE);
});

it('[AC-B1-27b#15] 原本没有手机号的用户被设号：不写 deleted_identities，仍作废会话', async () => {
  const s = setup({ user: { phone: null, nickname: '旧名' } });
  expect(await s.service.edit(s.command({ phone: NEW_PHONE, reason: REASON }))).toEqual({
    code: 0,
  });
  expect(s.statements.some((x) => x.sql.includes('"deleted_identities"'))).toBe(false);
  expect(s.revocations).toHaveLength(1);
  expect(s.audits[0]?.before).toEqual({ phone_masked: null });
});

it('[AC-B1-27b#23] 规范化后与现号相同、昵称去空白后相同：不查名单、不送审、不改行、不作废，只记空改动审计', async () => {
  const s = setup();
  const body = { phone: `+86 ${OLD_PHONE}`, nickname: ' 旧名 ', reason: REASON };
  expect(await s.service.edit(s.command(body))).toEqual({ code: 0 });
  expect(s.blocklistCalls).toEqual([]);
  expect(s.reviews).toEqual([]);
  expect(s.revocations).toEqual([]);
  expect(s.events.some((event) => event.startsWith('update'))).toBe(false);
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]).toMatchObject({ before: {}, after: { fields: [], reason: REASON } });
});

it('[AC-B1-27b#25] 写入时撞上手机号唯一索引 → 30411 并回滚', async () => {
  const s = setup({ conflict: true });
  expect(await s.service.edit(s.command({ phone: NEW_PHONE, reason: REASON }))).toEqual({
    code: 30411,
  });
  expect(s.events.at(-1)).toBe('rollback');
  expect(s.revocations).toEqual([]);
  expect(s.audits).toEqual([]);
});

it('[AC-B1-27b#37] 审计写失败：错误向上抛，事务回滚', async () => {
  const s = setup({ auditFails: true });
  await expect(s.service.edit(s.command({ nickname: '小狸', reason: REASON }))).rejects.toThrow(
    'audit down',
  );
  expect(s.events.at(-1)).toBe('rollback');
});

it('[AC-B1-27b#40] 送审时与现昵称相同、加锁后现昵称已被并发改走：重新来过并送审，不写未审核的昵称', async () => {
  const s = setup({ nicknames: ['小狸', '别名'] });
  expect(await s.service.edit(s.command({ nickname: '小狸', reason: REASON }))).toEqual({
    code: 0,
  });
  expect(s.events).toContain('rollback');
  expect(s.reviews).toEqual([{ appId: APP, text: '小狸' }]);
  expect(s.audits).toHaveLength(1);
  expect(s.audits[0]).toMatchObject({ before: { nickname: '旧名' }, after: { nickname: '小狸' } });
});
