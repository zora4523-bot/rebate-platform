// B1-03zh rule-test kit (规划/08 BR-ID-36 细则「规则清单的启停」; orchestrator ruling D10-536).
// The switch is set by writing app.risk_rules.status directly: the console's enable / disable
// (B1-03zg) is not on this branch, and the rule is about what the readers do with the stored status.
// HTTP cases run on the real AppModule (test/spec/identity/oauth-login/kit.ts): each test opens its
// own app, so a NotImplemented factory fails that test and not a setup hook. Time only moves through
// the injected FixedClock; the cache period is the configuration items' (规划/04 §10.2: the content
// module's configuration cache, CONTENT_CACHE_TTL_MS).
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { CONTENT_CACHE_TTL_MS } from '../../../../apps/api/src/modules/content/domain/cache-policy.ts';
import {
  DEVICE_LOG_CONTEXT,
  LEGAL,
  closeOauthKit,
  fixture,
  openOauthKit,
  validate,
  type Client,
  type Fixture,
} from '../../identity/oauth-login/kit.ts';
import { outbox, type Response } from '../../identity/sms-codes/http-kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import { seedUser as seedRegisteredUser } from '../../identity/registration/kit.ts';
import { landing, loginLog, seedUser as seedGrowthUser } from '../../growth/landing-review/kit.ts';

/** The refresh period of configuration items, which the rule status shares (BR-ID-36). */
export const TTL_MS = CONTENT_CACHE_TTL_MS;
export const AT = '2026-10-20T02:00:00.000Z';
export const SMS_PATH = '/v1/auth/sms-codes';
export const SMS_LOGIN_PATH = '/v1/auth/login/sms';
/** Low-entropy fixture digest (no real key material in tests). */
export const DEVICE_DIGEST = 'ab12'.repeat(16);

/** Stored statuses: the console's two (04 §6.6) and the writers' lazily registered `active`. */
export type StoredStatus = 'enabled' | 'disabled' | 'active';

/** Scene and action the writers register each rule with (risk/application/*). */
const RULES = {
  SMS_BLOCKED_PREFIX: { scene: 'register', risk_action: 'block' },
  DEVICE_REGISTER_LIMIT: { scene: 'register', risk_action: 'block' },
  BLACKLIST_PHONE: { scene: 'register', risk_action: 'block' },
  BLACKLIST_DEVICE: { scene: 'register', risk_action: 'block' },
  BLACKLIST_HIT: { scene: 'order', risk_action: 'void_commission' },
  SAME_DEVICE_MULTI_ACCOUNT: { scene: 'withdrawal', risk_action: 'manual_review' },
  inv_09_same_device: { scene: 'invite_relation', risk_action: 'block' },
} as const;
export type RuleId = keyof typeof RULES;

/** A fresh app id: lower-case, at most 32 characters (the x-app-id contract). */
export function newAppId(): string {
  return `rt_${randomBytes(12).toString('hex')}`;
}

/**
 * Sets the rule's status as the console would: the row is created when missing (with the scene and
 * action its writer registers), otherwise only status, version and updated_at change.
 */
export async function setRuleStatus(
  db: Kysely<DB>,
  appId: string,
  ruleId: RuleId,
  status: StoredStatus,
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

/** setRuleStatus for the fixture's app at its Clock's now. */
export function toggle(f: Fixture, ruleId: RuleId, status: StoredStatus): Promise<void> {
  return setRuleStatus(f.kit.suite.db, f.appId, ruleId, status, f.kit.clock.now());
}

export interface RuleRow {
  rule_id: string;
  scene: string;
  risk_action: string;
  status: string;
  version: number;
}
export async function rules(db: Kysely<DB>, appId: string): Promise<RuleRow[]> {
  const result = await sql<RuleRow>`SELECT rule_id, scene, risk_action, status, version
    FROM app.risk_rules WHERE app_id = ${appId} ORDER BY rule_id`.execute(db);
  return result.rows;
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
  related_phone_hmac: string | null;
  related_phone_masked: string | null;
  created_at: Date;
}
export async function hits(db: Kysely<DB>, appId: string): Promise<HitRow[]> {
  const result = await sql<HitRow>`SELECT app_id, user_id, rule_id, risk_action,
    dimension, value_hmac, ref_type, ref_id, request_type, related_phone_hmac,
    related_phone_masked, created_at
    FROM app.risk_hits WHERE app_id = ${appId} ORDER BY id`.execute(db);
  return result.rows;
}
export function appHits(f: Fixture): Promise<HitRow[]> {
  return hits(f.kit.suite.db, f.appId);
}

/** A processing appeal of a register blocked request (BR-ID-36 被拦截请求申诉), as stored. */
export async function seedAppeal(db: Kysely<DB>, appId: string, hit: HitRow, at: Date) {
  expect(hit.ref_type).toBe('blocked_request');
  expect(hit.related_phone_hmac).toEqual(expect.any(String));
  const deadline = new Date(at.getTime() + 15 * 86_400_000);
  await sql`INSERT INTO app.appeals
      (id, app_id, user_id, target_type, request_type, target_id, related_phone_hmac, status,
       content, deadline_at, created_at, updated_at)
    VALUES (${randomUUID()}, ${appId}, NULL, 'blocked_request', 'register', ${hit.ref_id},
      ${hit.related_phone_hmac}, 'processing', 'fixture appeal', ${deadline}, ${at},
      ${at})`.execute(db);
}
export async function appeals(db: Kysely<DB>, appId: string) {
  const result = await sql<Record<string, unknown>>`SELECT * FROM app.appeals
    WHERE app_id = ${appId} ORDER BY id`.execute(db);
  return result.rows;
}

/** One real AppModule per test (Redis and a test database included), closed afterwards. */
export async function withApp(run: (f: Fixture) => Promise<void>): Promise<void> {
  const kit = await openOauthKit();
  try {
    await run(await fixture(kit));
  } finally {
    await closeOauthKit(kit);
  }
}

/** A login-purpose code request of the number, signed by the device. */
export function sendCode(f: Fixture, number: string, device: Client = f.device) {
  return device.post(SMS_PATH, { phone: number, purpose: 'login' });
}

/** The send was accepted and the code went out: returns the code. */
export function codeSent(f: Fixture, response: Response, number: string): string {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  validate(f.kit, SMS_PATH, response);
  const message = outbox(f.kit.app).findLast((m) => m.phone === number && m.purpose === 'login');
  expect(message?.code).toMatch(/^\d{6}$/);
  return message!.code;
}

/** Nothing went out for the number. */
export function nothingSent(f: Fixture, number: string): void {
  expect(outbox(f.kit.app).filter((m) => m.phone === number)).toEqual([]);
}

/** Code request then SMS login of the number on the device (new or existing account). */
export async function smsLogin(
  f: Fixture,
  number: string,
  device: Client = f.device,
): Promise<Response> {
  const code = codeSent(f, await sendCode(f, number, device), number);
  return device.post(SMS_LOGIN_PATH, {
    phone: number,
    code,
    legal_versions: LEGAL,
    consent_at: f.kit.clock.now().toISOString(),
  });
}

/** `count` accounts registered on the device at the Clock's now (the device limit is 3). */
export async function fillDevice(f: Fixture, device: Client = f.device, count = 3) {
  for (let i = 0; i < count; i++) {
    const uid = await seedRegisteredUser(f.kit.suite.db, f.appId);
    await sql`INSERT INTO app.device_registrations
      (app_id, device_hash, user_id, register_method, created_at)
      VALUES (${f.appId}, ${device.deviceHash}, ${uid}, 'sms', ${f.kit.clock.now()})`.execute(
      f.kit.suite.db,
    );
  }
}

export async function deviceRegistrations(f: Fixture, device: Client = f.device) {
  const result = await sql<{ user_id: string }>`SELECT user_id FROM app.device_registrations
    WHERE app_id = ${f.appId} AND device_hash = ${device.deviceHash} ORDER BY user_id`.execute(
    f.kit.suite.db,
  );
  return result.rows;
}

/**
 * BR-INV-09 fixture (as test/spec/growth/landing-review/login.int.test.ts): an invitee with a
 * phone, bound through the landing page to an inviter who logged in on the fixture's device.
 */
export async function boundAccount(f: Fixture) {
  const number = phone();
  const uid = await seedGrowthUser(f.db, f.appId, f.crypto.blindIndex(number, 'users.phone'));
  const parentId = await seedGrowthUser(f.db, f.appId);
  await landing(f.db, f.appId, uid, parentId);
  const hash = f.crypto.blindIndex(f.device.deviceId, DEVICE_LOG_CONTEXT);
  await loginLog(f.db, f.appId, parentId, hash);
  return { uid, parentId, number, hash };
}

export function phoneDigest(f: Fixture, number: string): string {
  return f.crypto.blindIndex(number, 'users.phone');
}

export function masked(number: string): string {
  return `${number.slice(0, 3)}****${number.slice(-4)}`;
}
