// Invite-relation hit writer (task B1-03x; BR-INV-08 30403 refusals, BR-INV-09 same-device
// unbinding at first App login; orchestrator rulings E23, E32). growth calls it inside its own
// transaction when it refuses a binding or unbinds a relation; the caller wires it in a later task.
//
// record(trx, input): validates the input before any SQL (TypeError), then, on the caller's
// transaction handle as is (so both rows commit or roll back with the caller's work):
//   1. registers the rule row in app.risk_rules (scene invite_relation, conditions {}, risk_action
//      block, status active, version 1) with ON CONFLICT (app_id, rule_id) DO NOTHING, never a
//      read-then-insert: an existing row (possibly configured by admins since) is left untouched,
//      and two concurrent first hits end on the unique constraint (hard rule 4);
//   2. appends one app.risk_hits row: ref_type invite_relation, ref_id = the invitee's user_id,
//      risk_action block (BR-INV-09's unbinding is told apart by rule_id inv_09_same_device; the
//      risk_action CHECKs are not widened, E32).
// Both timestamps and the rule row's UUIDv7 come from the injected Clock's now, read once per
// record; the writer never reads the wall clock. value_hmac is computed by the caller and stored as
// given. Insert-only: nothing is updated or deleted.
//
// Rule status (B1-03zh, BR-ID-36 细则「规则清单的启停」, D10-536; ./risk-rule-status.ts): while the
// rule of the app is disabled, record writes nothing (read through the caller's transaction,
// cached for the configuration items' period on the injected Clock). One read per judgement (money
// r1 S1): a caller whose own decision already found the rule in force and acted on it (growth's
// same-device unbinding) passes decided_in_force: true and the status is not read again, so a
// cache expiry between the decision and the write never leaves the action without its hit.
//
// Rule ↔ dimension: the same-device rules record dimension device_id_hash, the self and descendant
// rules user_id (E23 §9.2 3; review S2 of the rule tests). Any other pairing is refused.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import { createRiskRuleStatusReader, type RiskRuleStatusReader } from './risk-rule-status.ts';

export type InviteRelationHitRuleId =
  'inv_08_self' | 'inv_08_descendant' | 'inv_08_same_device' | 'inv_09_same_device';

export interface InviteRelationHitInput {
  readonly app_id: string;
  /** 被邀请人；同时用作 risk_hits.ref_id。 */
  readonly user_id: string;
  readonly rule_id: InviteRelationHitRuleId;
  readonly dimension: 'user_id' | 'device_id_hash';
  /** 调用方已计算的 HMAC，原样保存。 */
  readonly value_hmac: string;
  /**
   * B1-03zh (BR-ID-36, one read per judgement): the caller's decision already found rule_id in
   * force and acted on it, so the status is not read again. Absent → the writer reads it itself.
   */
  readonly decided_in_force?: true;
}

export interface InviteRelationHitWriter {
  /** 在调用方事务内登记规则并追加命中，risk_action 固定为 block。 */
  record(trx: Transaction<DB>, input: InviteRelationHitInput): Promise<void>;
}

export interface InviteRelationHitWriterOptions {
  readonly clock: Clock;
  /** Rule status reader (B1-03zh); defaults to one of its own on `clock`, read through trx. */
  readonly rules?: RiskRuleStatusReader;
}

/** The dimension each rule records (E23 §9.2 3). */
const RULE_DIMENSIONS: ReadonlyMap<string, InviteRelationHitInput['dimension']> = new Map([
  ['inv_08_self', 'user_id'],
  ['inv_08_descendant', 'user_id'],
  ['inv_08_same_device', 'device_id_hash'],
  ['inv_09_same_device', 'device_id_hash'],
]);

const SCENE = 'invite_relation';
const REF_TYPE = 'invite_relation';
const RISK_ACTION = 'block';

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`invite relation hit: ${field} must be a non-empty string`);
  }
  return value;
}

/** Checks the whole input; throws TypeError before any statement is built. */
function validate(input: InviteRelationHitInput): InviteRelationHitInput & { decided: boolean } {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('invite relation hit: input must be an object');
  }
  const ruleId: unknown = input.rule_id;
  const expected = typeof ruleId === 'string' ? RULE_DIMENSIONS.get(ruleId) : undefined;
  if (expected === undefined) {
    throw new TypeError('invite relation hit: unknown rule_id');
  }
  if (input.dimension !== expected) {
    throw new TypeError(
      `invite relation hit: rule ${String(ruleId)} records dimension ${expected}`,
    );
  }
  return {
    app_id: requireText(input.app_id, 'app_id'),
    user_id: requireText(input.user_id, 'user_id'),
    rule_id: ruleId as InviteRelationHitRuleId,
    dimension: expected,
    value_hmac: requireText(input.value_hmac, 'value_hmac'),
    decided: input.decided_in_force === true,
  };
}

export function createInviteRelationHitWriter(
  options: InviteRelationHitWriterOptions,
): InviteRelationHitWriter {
  const { clock } = options;
  const rules = options.rules ?? createRiskRuleStatusReader({ clock });
  return {
    async record(trx, rawInput) {
      const input = validate(rawInput);
      // A disabled rule writes no hit row (BR-ID-36); a caller's decision is not read again.
      if (
        !input.decided &&
        !(await rules.isEnabled({ app_id: input.app_id, rule_id: input.rule_id }, trx))
      )
        return;
      const now = clock.now();
      const app = trx.withSchema('app');
      await app
        .insertInto('risk_rules')
        .values({
          id: newUuidV7(now),
          app_id: input.app_id,
          rule_id: input.rule_id,
          scene: SCENE,
          conditions: sql`'{}'::jsonb`,
          risk_action: RISK_ACTION,
          status: 'active',
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
        .execute();
      await app
        .insertInto('risk_hits')
        .values({
          app_id: input.app_id,
          user_id: input.user_id,
          rule_id: input.rule_id,
          risk_action: RISK_ACTION,
          dimension: input.dimension,
          value_hmac: input.value_hmac,
          ref_type: REF_TYPE,
          ref_id: input.user_id,
          created_at: now,
        })
        .execute();
    },
  };
}
