// Unit tests of appealAttempts (CT-26e; BR-ID-36 细则): attempt_no and can_resubmit computed from
// the caller's appeal history only. The SQL runs against PostgreSQL in the rule tests.
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
import { expect, it, vi } from 'vitest';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';
import type { RiskStateService } from './risk-state.ts';
import {
  appealAttempts,
  createAppealsService,
  MAX_APPEAL_ATTEMPTS,
  nextAppealAttempt,
  type AccountRestriction,
  type AppealHistoryRow,
} from './appeals.ts';

const NOW = new Date('2026-10-23T02:00:00.000Z');
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';

function account(
  n: number,
  status: string,
  prev: 'frozen' | 'banned' = 'banned',
): AppealHistoryRow {
  return {
    id: `0199a3b4-5c6d-7e8f-9a0b-00000000000${n}`,
    target_type: 'account',
    target_id: USER,
    status,
    prev_risk_state: prev,
    created_at: new Date(Date.UTC(2026, 8, n)),
    closed_at: status === 'processing' ? null : new Date(Date.UTC(2026, 8, n, 12)),
  };
}

/** The state was last set before every fixture appeal closed (an upheld appeal restores it). */
const SINCE = new Date(Date.UTC(2026, 7, 1));
const BANNED: AccountRestriction = { state: 'banned', frozen_until: null, changed_at: SINCE };

it('[AC-CT-26e-UNIT#1] attempt_no counts appeals on the same target and penalty from 1', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'processing')];
  const result = appealAttempts([...rows].reverse(), BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3]);
  expect(rows.map((row) => result.get(row.id)?.can_resubmit)).toEqual([false, false, false]);
});

it('[AC-CT-26e-UNIT#2] latest upheld appeal with attempts left on a still-restricted account → can_resubmit', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld')];
  expect(appealAttempts(rows, BANNED, NOW).get(rows[1]!.id)).toEqual({
    attempt_no: 2,
    can_resubmit: true,
  });
  const frozen = {
    state: 'frozen',
    frozen_until: new Date(NOW.getTime() + 1000),
    changed_at: SINCE,
  } as const;
  const one = [account(1, 'upheld', 'frozen')];
  expect(appealAttempts(one, frozen, NOW).get(one[0]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#3] the third upheld appeal of one penalty uses up the attempts', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  const last = appealAttempts(rows, BANNED, NOW).get(rows[2]!.id);
  expect(last).toEqual({ attempt_no: MAX_APPEAL_ATTEMPTS, can_resubmit: false });
});

it('[AC-CT-26e-UNIT#4] no resubmission when the account is no longer restricted', () => {
  const rows = [account(1, 'upheld', 'frozen')];
  const expired = {
    state: 'frozen',
    frozen_until: new Date(NOW.getTime() - 1),
    changed_at: SINCE,
  } as const;
  expect(appealAttempts(rows, expired, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  const normal = { state: 'normal', frozen_until: null, changed_at: SINCE } as const;
  expect(appealAttempts(rows, normal, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
  expect(appealAttempts(rows, null, NOW).get(rows[0]!.id)?.can_resubmit).toBe(false);
});

it('[AC-CT-26e-UNIT#5] a revoked appeal or a frozen → banned change starts a new penalty at 1', () => {
  const rows = [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
    account(4, 'upheld', 'banned'),
    account(5, 'revoked', 'banned'),
    account(6, 'upheld', 'banned'),
  ];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id)?.attempt_no)).toEqual([1, 2, 3, 1, 2, 1]);
  // Escalated after three upheld appeals on the freeze: the ban is a new penalty.
  const escalated = rows.slice(0, 3);
  expect(appealAttempts(escalated, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(true);
});

it('[AC-CT-26e-UNIT#6] order appeals count per order and never offer a resubmission yet', () => {
  const order = (n: number, target: string, status: string): AppealHistoryRow => ({
    id: `0199a3b4-5c6d-7e8f-9a0b-10000000000${n}`,
    target_type: 'order',
    target_id: target,
    status,
    prev_risk_state: null,
    created_at: new Date(Date.UTC(2026, 8, n)),
    closed_at: new Date(Date.UTC(2026, 8, n, 12)),
  });
  const rows = [order(1, 'a', 'upheld'), order(2, 'b', 'upheld'), order(3, 'a', 'upheld')];
  const result = appealAttempts(rows, BANNED, NOW);
  expect(rows.map((row) => result.get(row.id))).toEqual([
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 1, can_resubmit: false },
    { attempt_no: 2, can_resubmit: false },
  ]);
});

it('[AC-CT-26e-UNIT#9] after the third upheld appeal of one penalty can_resubmit is false whatever the current state', () => {
  const rows = [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')];
  // banned → frozen is the same penalty: the attempts stay used up.
  const frozen = { state: 'frozen', frozen_until: null, changed_at: SINCE } as const;
  expect(appealAttempts(rows, frozen, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: false,
  });
  expect(appealAttempts(rows, BANNED, NOW).get(rows[2]!.id)?.can_resubmit).toBe(false);
});

const CLOSED = new Date(Date.UTC(2026, 8, 3, 12));

it('[AC-CT-26e-UNIT#10] nextAppealAttempt is the 30418 rule: above the cap only within one penalty', () => {
  expect(nextAppealAttempt(undefined, 0, 'banned')).toBe(1);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(4);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'frozen',
    ),
  ).toBe(4);
  expect(
    nextAppealAttempt(
      { status: 'upheld', prev_risk_state: 'frozen', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(1);
  expect(
    nextAppealAttempt(
      { status: 'revoked', prev_risk_state: 'banned', closed_at: CLOSED },
      3,
      'banned',
    ),
  ).toBe(1);
  expect(
    nextAppealAttempt({ status: 'upheld', prev_risk_state: null, closed_at: CLOSED }, 2, null),
  ).toBe(3);
});

// submit on a scripted driver: the user's risk row, no processing appeal, then the history.
function scripted(
  state: string,
  historyRows: readonly AppealHistoryRow[],
  changedAt: Date = SINCE,
) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      let rows: readonly unknown[] = [];
      if (compiled.sql.includes('from "app"."user_risk_state"')) {
        rows = [
          {
            state,
            reason: 'r',
            reason_category: 'other',
            frozen_until: null,
            changed_at: changedAt,
          },
        ];
      } else if (compiled.sql.includes('"status" = $')) {
        rows = [];
      } else if (compiled.sql.includes('from "app"."appeals"')) {
        rows = historyRows;
      }
      return Promise.resolve({ rows } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
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
  const setRiskState = vi.fn(async () => undefined);
  const riskState = {
    readRiskState: vi.fn(),
    setRiskState,
    checkRequest: vi.fn(),
  } as unknown as RiskStateService;
  const service = createAppealsService({
    db,
    clock: { now: () => NOW } as unknown as Clock,
    riskState,
    config: { configValue: vi.fn(async () => null) } as unknown as RateLimitConfigReader,
    logger: { warn: vi.fn() } as unknown as Pick<RootLogger, 'warn'>,
  });
  const submit = () =>
    db.transaction().execute((trx) =>
      service.submit(
        trx,
        { app_id: 'couli', user_id: USER },
        {
          target_type: 'account',
          content: '请复核',
        },
      ),
    );
  return { statements, setRiskState, submit };
}

it('[AC-CT-26e-UNIT#11] three upheld appeals on the current penalty → 30418, nothing inserted, risk state unchanged', async () => {
  const s = scripted('banned', [account(1, 'upheld'), account(2, 'upheld'), account(3, 'upheld')]);
  expect(await s.submit()).toEqual({ code: 30418 });
  expect(s.statements.some((sql) => sql.startsWith('insert'))).toBe(false);
  expect(s.setRiskState).not.toHaveBeenCalled();
});

it('[AC-CT-26e-UNIT#12] attempts left, or a freeze escalated to a ban → the appeal is created with its attempt_no', async () => {
  const two = scripted('banned', [account(1, 'upheld'), account(2, 'upheld')]);
  const result = await two.submit();
  expect(result.code).toBe(0);
  expect(two.statements.some((sql) => sql.startsWith('insert into "app"."appeals"'))).toBe(true);
  expect(two.setRiskState).toHaveBeenCalledTimes(1);
  const escalated = scripted('banned', [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
  ]);
  expect((await escalated.submit()).code).toBe(0);
  expect(escalated.setRiskState).toHaveBeenCalledTimes(1);
});

it('[AC-CT-26e-UNIT#15] a state set after the latest appeal closed is a new penalty: next attempt 1, can_resubmit', () => {
  const upheld = { status: 'upheld', prev_risk_state: 'frozen', closed_at: CLOSED };
  // Restored by the closer at closed_at (or earlier): the same penalty.
  expect(nextAppealAttempt(upheld, 3, 'frozen', CLOSED)).toBe(4);
  // Freeze expired, then frozen again later: a new penalty.
  expect(nextAppealAttempt(upheld, 3, 'frozen', new Date(CLOSED.getTime() + 1))).toBe(1);
  const rows = [
    account(1, 'upheld', 'frozen'),
    account(2, 'upheld', 'frozen'),
    account(3, 'upheld', 'frozen'),
  ];
  const refrozen = {
    state: 'frozen',
    frozen_until: null,
    changed_at: new Date(Date.UTC(2026, 9, 1)),
  } as const;
  expect(appealAttempts(rows, refrozen, NOW).get(rows[2]!.id)).toEqual({
    attempt_no: 3,
    can_resubmit: true,
  });
});

it('[AC-CT-26e-UNIT#16] submit after a new penalty imposed since the third upheld appeal creates the appeal', async () => {
  const later = new Date(Date.UTC(2026, 9, 1));
  const s = scripted(
    'frozen',
    [
      account(1, 'upheld', 'frozen'),
      account(2, 'upheld', 'frozen'),
      account(3, 'upheld', 'frozen'),
    ],
    later,
  );
  expect((await s.submit()).code).toBe(0);
  expect(s.setRiskState).toHaveBeenCalledTimes(1);
});
