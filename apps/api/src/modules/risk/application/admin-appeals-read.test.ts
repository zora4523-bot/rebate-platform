// Unit tests of the appeal console reads (B1-03zd): the pure rules, the refusals that come before
// any read, and the shape of one list / lookup over a scripted pg client (no database).
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type FieldCrypto } from '../../platform/index.ts';
import {
  AdminAppealsFieldsError,
  AdminAppealsRead,
  appealRevokePermission,
  blockedRequestCause,
  type AdminAppealsReadPorts,
} from './admin-appeals-read.ts';

const APP = 'couli';
const ADMIN = '019a0000-0000-7000-8000-0000000000a1';
const HANDLER = '019a0000-0000-7000-8000-0000000000a2';
const USER = '019a0000-0000-7000-8000-000000000030';
const APPEAL = '019a0000-0000-7000-8000-000000000d01';
const ORDER = '019a0000-0000-7000-8000-000000000e01';
const BLOCKED = '019a0000-0000-7000-8000-000000000f01';
const NOW = '2031-05-06T07:08:09.000Z';
const PHONE = '13812345678';
const actor = { appId: APP, adminId: ADMIN, ip: '203.0.113.9' };

type Rows = (text: string) => readonly Record<string, unknown>[];

/** An empty database: every count is 0, every other read has no rows. */
const nothing: Rows = (text) => (text.includes('count(') ? [{ total: '0' }] : []);

function harness(rows: Rows = nothing) {
  const sqls: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(text: string, params: readonly unknown[] = []) {
      sqls.push({ text, params });
      const result = rows(text);
      return { command: 'SELECT', rowCount: result.length, rows: result };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const audits: AuditInput[] = [];
  const crypto = {
    blindIndex: (value: string, context: string) => `hmac(${context}:${value})`,
  } as unknown as FieldCrypto;
  const ports: AdminAppealsReadPorts = {
    maskedPhones: async (_app, ids) => new Map(ids.map((id) => [id, '138****5678'])),
    adminNames: async (_app, ids) => new Map(ids.map((id) => [id, '客服小林'])),
    subOrderNos: async (_app, ids) => new Map(ids.map((id) => [id, `SUB-${id.slice(-4)}`])),
    usersByPhoneHmac: async () => [USER],
    normalizePhone: (input) => {
      const digits = input.replace(/[\s-]/g, '').replace(/^\+86/, '');
      return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
    },
  };
  const reads = new AdminAppealsRead({
    db,
    clock: new FixedClock(NOW),
    crypto,
    ports,
    audit: { append: async (input) => void audits.push(input) },
  });
  return { reads, sqls, audits };
}

async function refusedWith(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdminAppealsFieldsError);
  const refused = error as AdminAppealsFieldsError;
  return { fields: refused.fields, reason: refused.reason };
}

it('[AC-B1-03zd#3] revoke_permission: an account appeal without a known penalty and an order appeal need nothing extra', () => {
  expect(
    appealRevokePermission({ target_type: 'order', prev_risk_state: null, cause: 'blocklist' }),
  ).toBeNull();
  expect(
    appealRevokePermission({ target_type: 'account', prev_risk_state: null, cause: null }),
  ).toBeNull();
});

it('[AC-B1-03zd#4] blocklist cause: an unknown BLACKLIST_ suffix and an empty list are cause rule', () => {
  expect(blockedRequestCause(['BLACKLIST_HIT'])).toEqual({
    cause: 'rule',
    blocklist_dimension: null,
  });
  expect(blockedRequestCause([])).toEqual({ cause: 'rule', blocklist_dimension: null });
  expect(blockedRequestCause(['SMS_BLOCKED_PREFIX', 'BLACKLIST_DEVICE'])).toEqual({
    cause: 'blocklist',
    blocklist_dimension: 'device',
  });
});

it('[AC-B1-03zd#24] list: q out of 1–64 after trimming and a bad page size are refused before any read', async () => {
  const { reads, sqls } = harness();
  expect(await refusedWith(reads.list(actor, { q: '   ' }))).toEqual({
    fields: ['q'],
    reason: undefined,
  });
  expect(await refusedWith(reads.list(actor, { q: 'x'.repeat(65) }))).toMatchObject({
    fields: ['q'],
  });
  expect(await refusedWith(reads.list(actor, { page_size: 201 }))).toMatchObject({
    fields: ['page_size'],
  });
  expect(await refusedWith(reads.list(actor, { page: 0 }))).toMatchObject({ fields: ['page'] });
  expect(sqls).toEqual([]);
});

it('[AC-B1-03zd#23] list: a q that is no uuid matches nothing and reads nothing', async () => {
  const { reads, sqls } = harness();
  expect(await reads.list(actor, { q: ` ${'q'.repeat(64)} ` })).toEqual({
    items: [],
    page: 1,
    page_size: 20,
    total: 0,
    counts: { processing: 0, overdue: 0, closed: 0, all: 0 },
  });
  expect(sqls).toEqual([]);
});

it('[AC-B1-03zd#20] list: rows through the ports, newest first, counts and total from the app scope', async () => {
  const created = new Date('2031-05-05T00:00:00.000Z');
  const { reads, sqls } = harness((text) => {
    if (text.includes('filter (where')) {
      return [{ processing: '2', overdue: '1', closed: '3', all: '5' }];
    }
    if (text.includes('count(*)')) return [{ total: '1' }];
    return [
      {
        id: APPEAL,
        user_id: USER,
        target_type: 'order',
        target_id: ORDER,
        request_type: null,
        related_phone_hmac: null,
        prev_risk_state: null,
        status: 'processing',
        content: '陈述',
        deadline_at: new Date('2031-05-08T16:00:00.000Z'),
        handler_id: HANDLER,
        closed_at: null,
        row_version: 1,
        created_at: created,
      },
    ];
  });
  const page = await reads.list(actor, { target_type: 'order', overdue: true });
  expect(page).toEqual({
    items: [
      {
        appeal_id: APPEAL,
        user: { user_id: USER, phone_masked: '138****5678' },
        target_type: 'order',
        target_id: ORDER,
        target_no: `SUB-${ORDER.slice(-4)}`,
        request_type: null,
        prev_risk_state: null,
        created_at: created.toISOString(),
        deadline_at: '2031-05-08T16:00:00.000Z',
        status: 'processing',
        handler_id: HANDLER,
        handler_name: '客服小林',
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
    counts: { processing: 2, overdue: 1, closed: 3, all: 5 },
  });
  expect(sqls).toHaveLength(3);
  for (const { params } of sqls) expect(params).toContain(APP);
  // overdue is judged with the injected clock, not the database's now().
  expect(sqls[1]!.text).toContain('"deadline_at" <');
  expect(sqls[1]!.params.map(String)).toContain(String(new Date(NOW)));
  expect(sqls[2]!.text).toMatch(/order by "created_at" desc, "id" desc/);
});

it('[AC-B1-03zd#36] detail: an appeal_id that is no uuid, or no row of this app, is 20001 appeal_id', async () => {
  const { reads, sqls } = harness();
  expect(await refusedWith(reads.get(actor, 'not-an-appeal-id'))).toMatchObject({
    fields: ['appeal_id'],
  });
  expect(sqls).toEqual([]);
  expect(await refusedWith(reads.get(actor, APPEAL))).toMatchObject({ fields: ['appeal_id'] });
  expect(sqls).toHaveLength(1);
  expect(sqls[0]!.params).toEqual([APP, APPEAL]);
});

it.each<[string, Record<string, string>]>([
  ['none', {}],
  ['two', { phone: PHONE, user_id: USER }],
  ['three', { phone: PHONE, user_id: USER, blocked_request_id: BLOCKED }],
])('[AC-B1-03zd#40] lookup: %s of the three keys → 20001 naming all three', async (_l, query) => {
  const { reads, sqls, audits } = harness();
  expect(await refusedWith(reads.blockedRequests(actor, query))).toEqual({
    fields: ['phone', 'user_id', 'blocked_request_id'],
    reason: undefined,
  });
  expect(sqls).toEqual([]);
  expect(audits).toEqual([]);
});

it('[AC-B1-03zd#41] lookup: a phone that is no mainland mobile → 20001 phone_invalid, nothing read or audited', async () => {
  const { reads, sqls, audits } = harness();
  expect(await refusedWith(reads.blockedRequests(actor, { phone: '12345678901' }))).toEqual({
    fields: ['phone'],
    reason: 'phone_invalid',
  });
  expect(sqls).toEqual([]);
  expect(audits).toEqual([]);
});

function lookupRows(text: string): readonly Record<string, unknown>[] {
  if (text.includes('count(distinct')) return [{ total: '1' }];
  if (text.includes('group by')) {
    return [
      {
        ref_id: BLOCKED,
        request_type: 'withdraw',
        related_phone_masked: '138****5678',
        related_phone_hmac: 'hmac(users.phone:13812345678)',
        amount_fen: 8800n,
        blocked_at: new Date('2031-05-06T06:00:00.000Z'),
        rule_ids: ['BLACKLIST_ALIPAY'],
      },
    ];
  }
  return [];
}

it('[AC-B1-03zd#48] lookup by phone: matched by blind index, one item, one audit with the masked number only', async () => {
  const { reads, sqls, audits } = harness(lookupRows);
  const page = await reads.blockedRequests(actor, { phone: `+86 ${PHONE}` });
  expect(page).toEqual({
    items: [
      {
        blocked_request_id: BLOCKED,
        request_type: 'withdraw',
        phone_masked: '138****5678',
        blocked_at: '2031-05-06T06:00:00.000Z',
        cause: 'blocklist',
        blocklist_dimension: 'alipay',
        amount_fen: 8800,
        processing_appeal_id: null,
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
  });
  expect(sqls[0]!.params).toContain('hmac(users.phone:13812345678)');
  expect(sqls[0]!.params).toContain(USER);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    appId: APP,
    actor: ADMIN,
    action: 'blocked_request_lookup',
    ip: '203.0.113.9',
  });
  const text = JSON.stringify(audits[0]);
  expect(text).toContain('138****5678');
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain('hmac(');
  expect(JSON.stringify(page)).not.toContain('hmac(');
});

it('[AC-B1-03zd#48] lookups by user_id or id, and a phone lookup that finds nothing, write no audit', async () => {
  const found = harness(lookupRows);
  await found.reads.blockedRequests(actor, { user_id: USER });
  await found.reads.blockedRequests(actor, { blocked_request_id: BLOCKED });
  expect(found.audits).toEqual([]);
  const none = harness();
  expect(await none.reads.blockedRequests(actor, { phone: PHONE })).toMatchObject({
    items: [],
    total: 0,
  });
  expect(none.audits).toEqual([]);
});

it('[AC-B1-03zd#43] lookup by a user_id that is no uuid is an empty page without a read', async () => {
  const { reads, sqls } = harness(lookupRows);
  expect(await reads.blockedRequests(actor, { user_id: 'not-a-uid' })).toEqual({
    items: [],
    page: 1,
    page_size: 20,
    total: 0,
  });
  expect(sqls).toEqual([]);
});
