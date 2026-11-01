// B1-09m rule-test kit (规划/08 BR-ID-36 细则「规则清单的启停」, BR-ATTR-26; rulings D10-536 (b), D10-537).
// Orders have one rule, BLACKLIST_HIT, for both list dimensions. The B1-09b fixture is used as it
// is: the real pipeline and update step, real blocklist rows, risk's real ports on the same
// database. Its port spies are pointed here at ports built over the real status reader wrapped to
// record each read and, once armed, to step the clock right after a read (the entry of
// test/spec/risk/rule-toggle-identity/decision-hit-race.int.test.ts, without mocking the module).
// rebate.onBlacklistHit stays a fake standing for settlement's R6: it writes VOID / BLACKLIST in the
// step's transaction, so a void and its hit are read back together. The switch is set by writing
// app.risk_rules.status directly, as the B1-03zh kit does. Time only moves through the FixedClock.
// The test files open the database and pass it in: nothing here imports the test-database base.
//
// The disabled branch itself went in with B1-03zh (risk's match returns nothing), so it holds before
// this task. What this task adds is one read per judgement: applyOrderBlacklist tells recordHit the
// hit comes from this judgement. Every test therefore ends on a judgement that writes a hit, and
// expectOneReadPerJudgement is its last assertion: everything before it has been checked by the time
// a test goes red there.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { CONTENT_CACHE_TTL_MS } from '../../../../apps/api/src/modules/content/domain/cache-policy.ts';
import type { createOrderBlocklistPorts as CreatePorts } from '../../../../apps/api/src/modules/risk/application/order-blocklist.ts';
import type {
  RiskRuleKey,
  RiskRuleStatusReader,
  createRiskRuleStatusReader as CreateReader,
} from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import { existing, publishedOf, setup, type Fixture } from '../blacklist/kit.ts';
import { AFTER_CREDIT, CHANNEL, SUFFIX } from '../blacklist/plan-kit.ts';

// Same as the B1-09b kit: the risk public surface is loaded at run time.
const { createOrderBlocklistPorts, createRiskRuleStatusReader } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as {
  createOrderBlocklistPorts: typeof CreatePorts;
  createRiskRuleStatusReader: typeof CreateReader;
};

/** The refresh period of configuration items, which the rule status shares (BR-ID-36). */
export const TTL_MS = CONTENT_CACHE_TTL_MS;
/** The one rule of the order blacklist, whatever the dimension (D10-537). */
export const RULE_ID = 'BLACKLIST_HIT';
export const INSERTED = { ok: true, value: { kind: 'inserted' } };
export const UPDATED = { ok: true, value: { kind: 'updated' } };

type RuleStatus = 'enabled' | 'disabled' | 'active';

/** Scene and action each rule is registered with (risk/application/*). */
const RULES = {
  BLACKLIST_HIT: { scene: 'order', risk_action: 'void_commission' },
  BLACKLIST_PHONE: { scene: 'register', risk_action: 'block' },
} as const;

/** Sets the status as the console would: the row is created when missing, else status + version. */
export async function setRule(
  db: Kysely<DB>,
  appId: string,
  ruleId: keyof typeof RULES,
  status: RuleStatus,
  at: Date,
): Promise<void> {
  const { scene, risk_action: action } = RULES[ruleId];
  await sql`INSERT INTO app.risk_rules AS r
      (id, app_id, rule_id, scene, conditions, risk_action, status, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${appId}, ${ruleId}, ${scene}, '{}'::jsonb, ${action}, ${status}, 1,
      ${at}, ${at})
    ON CONFLICT (app_id, rule_id) DO UPDATE SET status = EXCLUDED.status,
      version = r.version + 1, updated_at = EXCLUDED.updated_at`.execute(db);
}

async function ruleRows(db: Kysely<DB>, appId: string) {
  const result = await sql<{ status: string; version: number }>`SELECT status, version
    FROM app.risk_rules WHERE app_id = ${appId} AND rule_id = ${RULE_ID}`.execute(db);
  return result.rows;
}

function withRule<F extends Fixture>(db: Kysely<DB>, f: F) {
  const appId = f.ctx.app_id;
  const ruleKey: RiskRuleKey = { app_id: appId, rule_id: RULE_ID };
  const reader = createRiskRuleStatusReader({ clock: f.clock });
  const reads: RiskRuleKey[] = [];
  let step: (() => void) | null = null;
  let sprung = 0;
  const rules: RiskRuleStatusReader = {
    async isEnabled(key, executor) {
      const answer = await reader.isEnabled(key, executor);
      reads.push(key);
      if (step !== null) {
        step();
        step = null;
        sprung += 1;
      }
      return answer;
    },
  };
  const ports = createOrderBlocklistPorts({ clock: f.clock, crypto: f.crypto, rules });
  f.match.mockImplementation((trx, input) => ports.match(trx, input));
  f.recordHit.mockImplementation((trx, input) => ports.recordHit(trx, input));
  f.onBlacklistHit.mockImplementation(async (trx, hit) => {
    await trx
      .withSchema('app')
      .updateTable('orders')
      .set({ rebate_status: 'VOID', reason: 'BLACKLIST' })
      .where('app_id', '=', hit.app_id)
      .where('order_id', '=', hit.order_id)
      .execute();
  });
  return {
    ...f,
    ruleKey,
    /** Every status read of the ports, in order (shared ports: other Apps' reads included). */
    reads,
    setRule: (status: RuleStatus) => setRule(db, appId, RULE_ID, status, f.clock.now()),
    ruleRows: () => ruleRows(db, appId),
    /** The reader's answer at the Clock's now; loads the cache when it is stale. Not recorded. */
    ruleInForce: () => reader.isEnabled(ruleKey, db),
    /**
     * Loads the cache with the current status at this instant, stores `status`, and leaves the cache
     * 1 ms from running out; the next read (the decision's) gets the cached answer and is followed
     * by that 1 ms, so anything read after the decision sees `status`. No wall-clock wait.
     */
    async changeRightAfterDecision(status: RuleStatus) {
      await reader.isEnabled(ruleKey, db);
      await setRule(db, appId, RULE_ID, status, f.clock.now());
      f.clock.advanceMs(TTL_MS - 1);
      step = () => f.clock.advanceMs(1);
    },
    /** The decision did read the status, and the cache ran out right after it. */
    decisionRaced() {
      expect(step).toBeNull();
      expect(sprung).toBe(1);
    },
    /** A disabled rule decided nothing so far. */
    async expectNothingDecided() {
      expect(f.recordHit).not.toHaveBeenCalled();
      expect(f.onBlacklistHit).not.toHaveBeenCalled();
      expect(publishedOf(f, AFTER_CREDIT)).toEqual([]);
      expect((await f.read()).hits).toEqual([]);
    },
    /** hitView of the hit this fixture's order must end with. */
    expectedHit(
      riskAction: 'void_commission' | 'manual_review',
      orderId: string,
      dimension: 'channel' | 'order_no_suffix' = 'channel',
      userId: string | null = f.userId,
    ) {
      return {
        user_id: userId,
        rule_id: RULE_ID,
        risk_action: riskAction,
        dimension,
        value_hmac: f.hmac(dimension, dimension === 'channel' ? CHANNEL : SUFFIX),
        ref_type: 'order',
        ref_id: orderId,
      };
    },
    /**
     * BR-ID-36, one read per judgement: this App's status was read through risk's port exactly once
     * per judgement of the test (orders reads nothing itself and repeats no rule code), and every
     * hit was handed over as decided by that judgement (D10-536 (b) §9 item 1).
     */
    expectOneReadPerJudgement(judgements: number) {
      expect(reads.filter((key) => key.app_id === appId)).toEqual(
        Array.from({ length: judgements }, () => ruleKey),
      );
      expect(f.recordHit).toHaveBeenCalled();
      for (const [, input] of f.recordHit.mock.calls) {
        expect(input).toMatchObject({ decided_in_force: true });
      }
    },
  };
}

/** A new sub-order of a fresh App through the real pipeline. */
export async function freshOrder(
  db: Kysely<DB>,
  patch?: Parameters<typeof setup>[1],
  options?: Parameters<typeof setup>[2],
) {
  return withRule(db, await setup(db, patch, options));
}

/** An order already stored with this rebate_status, updated through the real pipeline. */
export async function storedOrder(
  db: Kysely<DB>,
  rebateStatus: string,
  patch?: Parameters<typeof existing>[2],
  options?: Parameters<typeof existing>[3],
) {
  return withRule(db, await existing(db, rebateStatus, patch, options));
}

/** `other` goes through `owner`'s ports: one reader and one cache for both Apps, as in a worker. */
export function sharePorts(
  owner: Pick<Fixture, 'match' | 'recordHit'>,
  other: Pick<Fixture, 'match' | 'recordHit'>,
): void {
  other.match.mockImplementation((trx, input) => owner.match(trx, input));
  other.recordHit.mockImplementation((trx, input) => owner.recordHit(trx, input));
}
