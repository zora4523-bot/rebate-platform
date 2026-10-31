// Unit tests of the appeal console writes (B1-03ze): the pure rules, the refusals that come before
// any read, and the compare-and-set statements over a scripted pg client (no database).
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type EventBus } from '../../platform/index.ts';
import type { AdminAppealsRead } from './admin-appeals-read.ts';
import {
  AdminAppealConflictError,
  AdminAppealsWrite,
  AdminAppealsWriteFieldsError,
  appealConsoleText,
  appealResolveRequirement,
} from './admin-appeals-write.ts';
import type { RiskStateService } from './risk-state.ts';

const APP = 'couli';
const ADMIN = '019a0000-0000-7000-8000-0000000000a1';
const APPEAL = '019a0000-0000-7000-8000-000000000d01';
const USER = '019a0000-0000-7000-8000-000000000030';
const NOW = '2031-05-06T07:08:09.000Z';
const actor = { appId: APP, adminId: ADMIN, loginName: 'cs-lin', ip: null };

type Rows = (text: string) => readonly Record<string, unknown>[];

function harness(rows: Rows = () => []) {
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
  const published: unknown[] = [];
  const reads = {
    get: async (_actor: unknown, id: string) => ({ appeal_id: id }),
  } as unknown as AdminAppealsRead;
  const writes = new AdminAppealsWrite({
    db,
    clock: new FixedClock(NOW),
    events: {
      publish: async (_trx: unknown, event: unknown) => void published.push(event),
    } as unknown as EventBus,
    riskState: {
      setRiskState: async () => {
        throw new Error('not expected');
      },
    } as unknown as RiskStateService,
    config: { configValue: async () => null },
    logger: { warn: () => undefined },
    auditOn: () => ({ append: async (input) => void audits.push(input) }),
    restoreAfterUnban: async () => undefined,
    ports: { voidedOrderOwner: async () => null },
    reads,
  });
  return { writes, sqls, audits, published };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

const processingRow = {
  id: APPEAL,
  user_id: USER,
  target_type: 'order',
  target_id: '019a0000-0000-7000-8000-000000000e01',
  prev_risk_state: null,
  status: 'processing',
  handler_id: null,
  row_version: 2,
};

it('[AC-B1-03ze#3] requirement: upholding needs nothing extra whatever the target', () => {
  expect(
    appealResolveRequirement({
      decision: 'upheld',
      target_type: 'account',
      prev_risk_state: 'banned',
      cause: null,
    }),
  ).toEqual({ permission: null, step_up: null });
});

it('[AC-B1-03ze#4] requirement: revoking a freeze needs risk.freeze with totp, a rule block nothing', () => {
  expect(
    appealResolveRequirement({
      decision: 'revoked',
      target_type: 'account',
      prev_risk_state: 'frozen',
      cause: null,
    }),
  ).toEqual({ permission: 'risk.freeze', step_up: 'totp' });
  expect(
    appealResolveRequirement({
      decision: 'revoked',
      target_type: 'blocked_request',
      prev_risk_state: null,
      cause: 'rule',
    }),
  ).toEqual({ permission: null, step_up: null });
});

it('[AC-B1-03ze#5] console text: counted in characters (not UTF-16 units) after trimming', () => {
  expect(appealConsoleText(` ${'😀'.repeat(200)} `)).toBe('😀'.repeat(200));
  expect(appealConsoleText('😀'.repeat(201))).toBeNull();
});

it('[AC-B1-03ze#49] resolve: body refusals come before any read, decision first', async () => {
  const { writes, sqls } = harness();
  const cases: [unknown, string][] = [
    [{ note: '核实', expected_row_version: 0 }, 'decision'],
    [{ decision: 'upheld', note: '  ', expected_row_version: 0 }, 'note'],
    [{ decision: 'upheld', note: '核实', expected_row_version: -1 }, 'expected_row_version'],
  ];
  for (const [body, field] of cases) {
    const error = await failure(writes.prepareResolve(actor, APPEAL, body));
    expect(error).toBeInstanceOf(AdminAppealsWriteFieldsError);
    expect((error as AdminAppealsWriteFieldsError).fields).toEqual([field]);
  }
  const unknown = await failure(
    writes.prepareResolve(actor, 'not-an-appeal-id', {
      decision: 'upheld',
      note: '核实',
      expected_row_version: 0,
    }),
  );
  expect((unknown as AdminAppealsWriteFieldsError).fields).toEqual(['appeal_id']);
  expect(sqls).toEqual([]);
});

it('[AC-B1-03ze#46] resolve: another row_version or a closed appeal is 20902 before the write', async () => {
  const { writes, sqls } = harness((text) =>
    text.includes('from "app"."appeals"') ? [processingRow] : [],
  );
  const stale = await failure(
    writes.prepareResolve(actor, APPEAL, {
      decision: 'upheld',
      note: '核实',
      expected_row_version: 1,
    }),
  );
  expect(stale).toBeInstanceOf(AdminAppealConflictError);
  expect(sqls.some((q) => q.text.startsWith('update') || q.text.includes('UPDATE'))).toBe(false);
});

it('[AC-B1-03ze#33] claim: the update carries status and row_version in its WHERE; 0 rows → 20902, no audit', async () => {
  const { writes, sqls, audits } = harness((text) =>
    text.includes('from "app"."appeals"') ? [{ ...processingRow }] : [],
  );
  const error = await failure(writes.claim(actor, APPEAL, { expected_row_version: 2 }));
  expect(error).toBeInstanceOf(AdminAppealConflictError);
  const update = sqls.find((q) => q.text.includes('UPDATE app.appeals'));
  expect(update?.text).toMatch(/status = 'processing'/);
  expect(update?.text).toMatch(/row_version = \$\d+/);
  expect(update?.params).toContain(2);
  expect(sqls.some((q) => q.text.includes('for update'))).toBe(true);
  expect(audits).toEqual([]);
});

it('[AC-B1-03ze#30] claim: one row updated → a claim row of the new version, audit with the handler before and after', async () => {
  const { writes, audits, sqls } = harness((text) => {
    if (text.includes('UPDATE app.appeals')) return [{ handler_id: ADMIN }];
    if (text.includes('from "app"."appeals"')) return [{ ...processingRow, handler_id: 'other' }];
    return [];
  });
  expect(await writes.claim(actor, APPEAL, { expected_row_version: 2 })).toEqual({
    appeal_id: APPEAL,
  });
  const claimRow = sqls.find((q) => q.text.includes('INSERT INTO app.appeal_claims'));
  expect(claimRow?.params).toEqual(expect.arrayContaining([APP, APPEAL, 3, ADMIN]));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: 'appeal_claim',
    target: APPEAL,
    before: { handler_id: 'other', row_version: 2 },
    after: { handler_id: ADMIN, claimed_at: NOW, row_version: 3 },
  });
});

it('[AC-B1-03ze#64] register: a blank reason is refused before any read', async () => {
  const { writes, sqls } = harness();
  const error = await failure(
    writes.register(actor, {
      target_type: 'account',
      target_id: USER,
      content: '请核查',
      reason: ' \t ',
    }),
  );
  expect((error as AdminAppealsWriteFieldsError).fields).toEqual(['reason']);
  expect(sqls).toEqual([]);
});

it('[AC-B1-03ze#67] register: an order the port does not know as voided is 20001 target_id', async () => {
  const { writes, sqls } = harness();
  const error = await failure(
    writes.register(actor, {
      target_type: 'order',
      target_id: '019a0000-0000-7000-8000-000000000e01',
      content: '请核查',
      reason: '登记',
    }),
  );
  expect((error as AdminAppealsWriteFieldsError).fields).toEqual(['target_id']);
  expect(sqls).toEqual([]);
});
