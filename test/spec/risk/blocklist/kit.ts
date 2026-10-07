import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { BlocklistDimension } from '../../../../apps/api/src/modules/risk/index.ts';
import type { Clock, FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { context, type Kit } from '../../identity/registration/kit.ts';

export { openKit, closeKit, seedUser } from '../../identity/registration/kit.ts';
export type { Kit } from '../../identity/registration/kit.ts';
export const PHONE = '13812345678';
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function setup(kit: Kit) {
  const ctx = await context(kit);
  return {
    ...ctx,
    input: {
      app_id: ctx.appId,
      dimension: 'phone' as const,
      value: PHONE,
      related_phone: PHONE,
      request_type: 'register' as const,
    },
    options: { db: kit.db, clock: ctx.clock, crypto: kit.crypto, logger: ctx.options.logger },
  };
}

export async function seedBlock(
  db: Kysely<DB>,
  app: string,
  dimension: BlocklistDimension,
  hmac: string,
  clock: Clock,
  options: {
    status?: 'active' | 'inactive';
    expires?: Date;
    violation?: 'malicious_rights' | 'fraud_invite' | 'other';
  } = {},
) {
  const id = randomUUID();
  await sql`INSERT INTO app.blocklist
    (id, app_id, dimension, value_hmac, violation_type, reason, expire_at, status, created_by)
    VALUES (${id}, ${app}, ${dimension}, ${hmac}, ${options.violation ?? 'fraud_invite'},
      'fixture reason must never enter the response',
      ${options.expires ?? new Date(clock.now().getTime() + 60_000)},
      ${options.status ?? 'active'}, 'spec-fixture')`.execute(db);
  return id;
}

export function phoneHmac(crypto: FieldCrypto, phone = PHONE) {
  return crypto.blindIndex(phone, 'users.phone');
}

export interface HitRow {
  app_id: string;
  user_id: string | null;
  rule_id: string;
  risk_action: string;
  dimension: string;
  value_hmac: string;
  ref_type: string;
  ref_id: string;
  request_type: string | null;
  related_phone_hmac: string;
  related_phone_masked: string;
  amount_fen: bigint | null;
  created_at: Date;
}

export async function hits(db: Kysely<DB>, app: string, hmac?: string) {
  const result = await sql<HitRow>`SELECT app_id, user_id, rule_id, risk_action, dimension,
    value_hmac, ref_type, ref_id, request_type, related_phone_hmac, related_phone_masked,
    amount_fen, created_at FROM app.risk_hits WHERE app_id = ${app}
    ${hmac === undefined ? sql`` : sql`AND related_phone_hmac = ${hmac}`}
    ORDER BY id`.execute(db);
  return result.rows;
}

export async function expectRegistrationHit(
  db: Kysely<DB>,
  input: {
    app: string;
    crypto: FieldCrypto;
    clock: Clock;
    phone: string;
    dimension: string;
    value_hmac: string;
    rule: string;
  },
) {
  const rows = await hits(db, input.app, phoneHmac(input.crypto, input.phone));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: input.app,
    user_id: null,
    rule_id: input.rule,
    risk_action: 'block',
    dimension: input.dimension,
    value_hmac: input.value_hmac,
    ref_type: 'blocked_request',
    request_type: 'register',
    related_phone_hmac: phoneHmac(input.crypto, input.phone),
    related_phone_masked: `${input.phone.slice(0, 3)}****${input.phone.slice(-4)}`,
    amount_fen: null,
    created_at: input.clock.now(),
  });
  expect(rows[0]!.ref_id).toMatch(UUID_V7);
  const rules = await sql<{
    scene: string;
    risk_action: string;
    status: string;
    version: number;
    conditions: unknown;
  }>`
    SELECT scene, risk_action, status, version, conditions FROM app.risk_rules
    WHERE app_id = ${input.app} AND rule_id = ${input.rule}`.execute(db);
  expect(rules.rows).toEqual([
    { scene: 'register', risk_action: 'block', status: 'active', version: 1, conditions: {} },
  ]);
  return rows[0]!;
}
