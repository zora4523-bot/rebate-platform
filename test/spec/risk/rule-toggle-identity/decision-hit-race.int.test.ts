// BR-ID-36 细则「规则清单的启停」 (D10-536; money r1 S1 of B1-03zh): a decision point and the hit
// writer behind it must agree on whether the rule is in force. If the rule status cache runs out
// between the decision's read and the writer's read, the request may be let through with no hit,
// or refused / unbound with its hit; never refused / unbound without a hit to appeal.
//
// Entry used to land the expiry exactly between the two reads: this file mocks
// risk/application/risk-rule-status.ts so that every reader the real AppModule creates is the real
// reader wrapped. After the first read of the trapped (app_id, rule_id) has its answer, the wrapper
// moves the injected FixedClock on by 1 ms. The cache was loaded TTL_MS − 1 earlier while the rule
// was enabled; the rule is disabled in the database by then. So the decision sees «enabled» and any
// later read of the same rule sees «disabled». No wall-clock wait. Real signed HTTP requests.
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import type {
  RiskRuleStatusReader,
  RiskRuleStatusReaderOptions,
} from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import { accepted, rejected, type Fixture } from '../../identity/oauth-login/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import {
  assertHit,
  hits as inviteHits,
  relationLogs,
  user,
} from '../../growth/landing-review/kit.ts';
import {
  SMS_LOGIN_PATH,
  SMS_PATH,
  TTL_MS,
  appHits,
  boundAccount,
  codeSent,
  fillDevice,
  nothingSent,
  phoneDigest,
  sendCode,
  smsLogin,
  toggle,
  withApp,
  type RuleId,
} from './kit.ts';

type StatusModule =
  typeof import('../../../../apps/api/src/modules/risk/application/risk-rule-status.ts');

/** The one read to follow with the clock step, and how many times it fired. */
interface Trap {
  readonly app_id: string;
  readonly rule_id: string;
  spring(): void;
}
const race = vi.hoisted(() => ({ trap: null as Trap | null, sprung: 0 }));

vi.mock(
  '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts',
  async (original) => {
    const actual = await original<StatusModule>();
    return {
      ...actual,
      createRiskRuleStatusReader(options: RiskRuleStatusReaderOptions): RiskRuleStatusReader {
        const reader = actual.createRiskRuleStatusReader(options);
        return {
          async isEnabled(key, executor) {
            const answer = await reader.isEnabled(key, executor);
            const trap = race.trap;
            if (trap !== null && trap.app_id === key.app_id && trap.rule_id === key.rule_id) {
              race.trap = null;
              race.sprung += 1;
              trap.spring();
            }
            return answer;
          },
        };
      },
    };
  },
);

/**
 * The rule's cached «enabled» is TTL_MS − 1 old; the next read of it (the decision) is followed by
 * a 1 ms clock step, so the cache runs out right after the decision and before any hit write.
 */
function expireRightAfterDecision(f: Fixture, ruleId: RuleId): void {
  f.kit.clock.advanceMs(TTL_MS - 1);
  race.sprung = 0;
  race.trap = { app_id: f.appId, rule_id: ruleId, spring: () => f.kit.clock.advanceMs(1) };
}

/** The decision point did read the rule status through risk's port, once trapped. */
function decisionRead(): void {
  expect(race.trap).toBeNull();
  expect(race.sprung).toBe(1);
}

it('[AC-B1-03zh#19][BR-ID-36][BR-ID-05] SMS_BLOCKED_PREFIX 缓存恰在判定之后、写命中之前到期：拒绝（44001）⇔ 有该规则命中，放行 ⇔ 无命中；不得拒绝而无命中', async () => {
  await withApp(async (f) => {
    await toggle(f, 'SMS_BLOCKED_PREFIX', 'enabled');
    // Loads the cache with «enabled» at this instant: refused, with its hit.
    const first = phone('170');
    rejected(f.kit, SMS_PATH, await sendCode(f, first), 44001);
    expect(
      (await appHits(f)).filter((row) => row.related_phone_hmac === phoneDigest(f, first)),
    ).toEqual([expect.objectContaining({ rule_id: 'SMS_BLOCKED_PREFIX' })]);

    await toggle(f, 'SMS_BLOCKED_PREFIX', 'disabled');
    expireRightAfterDecision(f, 'SMS_BLOCKED_PREFIX');
    const raced = phone('170');
    const response = await sendCode(f, raced);
    decisionRead();
    const refused = response.statusCode !== 200;
    const rows = (await appHits(f)).filter(
      (row) => row.related_phone_hmac === phoneDigest(f, raced),
    );
    expect({ refused, hits: rows.map((row) => [row.rule_id, row.dimension]) }).toEqual(
      refused
        ? { refused: true, hits: [['SMS_BLOCKED_PREFIX', 'phone_prefix']] }
        : { refused: false, hits: [] },
    );
    if (refused) {
      rejected(f.kit, SMS_PATH, response, 44001);
      nothingSent(f, raced);
    } else {
      codeSent(f, response, raced);
    }

    // From here the disabled status is in force: no decision, no hit.
    const later = phone('170');
    codeSent(f, await sendCode(f, later), later);
    expect(
      (await appHits(f)).filter((row) => row.related_phone_hmac === phoneDigest(f, later)),
    ).toEqual([]);
  });
});

async function accountsOf(f: Fixture, number: string) {
  const result = await sql<{ id: string }>`SELECT id FROM app.users
    WHERE app_id = ${f.appId} AND phone_hmac = ${phoneDigest(f, number)}`.execute(f.kit.suite.db);
  return result.rows;
}

it('[AC-B1-03zh#20][BR-ID-36][BR-ID-05] DEVICE_REGISTER_LIMIT 缓存恰在判定之后、写命中之前到期：拦截注册 ⇔ 有该规则命中，放行注册 ⇔ 无命中', async () => {
  await withApp(async (f) => {
    await fillDevice(f);
    await toggle(f, 'DEVICE_REGISTER_LIMIT', 'enabled');
    // Loads the cache with «enabled» at this instant: refused, with its hit.
    const first = phone();
    rejected(f.kit, SMS_LOGIN_PATH, await smsLogin(f, first), 44001);
    expect(
      (await appHits(f)).filter((row) => row.related_phone_hmac === phoneDigest(f, first)),
    ).toEqual([expect.objectContaining({ rule_id: 'DEVICE_REGISTER_LIMIT' })]);

    await toggle(f, 'DEVICE_REGISTER_LIMIT', 'disabled');
    expireRightAfterDecision(f, 'DEVICE_REGISTER_LIMIT');
    const raced = phone();
    const response = await smsLogin(f, raced);
    decisionRead();
    const refused = response.statusCode !== 200;
    const rows = (await appHits(f)).filter(
      (row) => row.related_phone_hmac === phoneDigest(f, raced),
    );
    expect({
      refused,
      accounts: (await accountsOf(f, raced)).length,
      hits: rows.map((row) => [row.rule_id, row.dimension, row.value_hmac]),
    }).toEqual(
      refused
        ? {
            refused: true,
            accounts: 0,
            hits: [['DEVICE_REGISTER_LIMIT', 'device', f.device.deviceHash]],
          }
        : { refused: false, accounts: 1, hits: [] },
    );
    if (refused) {
      rejected(f.kit, SMS_LOGIN_PATH, response, 44001);
    } else {
      expect(accepted(f.kit, SMS_LOGIN_PATH, response).is_new_user).toBe(true);
    }
  });
});

it('[AC-B1-03zh#21][BR-ID-36][BR-INV-09] inv_09_same_device 缓存恰在判定之后、写命中之前到期：解除归属并写 risk_same_device 变更 ⇔ 有该规则命中；放行则三者皆无', async () => {
  await withApp(async (f) => {
    await toggle(f, 'inv_09_same_device', 'enabled');
    // Loads the cache with «enabled» at this instant: unbound, with its change and its hit.
    const a = await boundAccount(f);
    expect(accepted(f.kit, SMS_LOGIN_PATH, await smsLogin(f, a.number))).toMatchObject({
      user_id: a.uid,
      is_new_user: false,
    });
    await assertHit(f.db, f.appId, a.uid, a.parentId, a.hash, f.kit.clock.now());

    await toggle(f, 'inv_09_same_device', 'disabled');
    expireRightAfterDecision(f, 'inv_09_same_device');
    const b = await boundAccount(f);
    expect(accepted(f.kit, SMS_LOGIN_PATH, await smsLogin(f, b.number))).toMatchObject({
      user_id: b.uid,
      is_new_user: false,
    });
    decisionRead();
    const invitee = await user(f.db, f.appId, b.uid);
    const unbound = invitee.parent_id === null;
    const changes = (await relationLogs(f.db, f.appId)).filter((log) => log.user_id === b.uid);
    const recorded = (await inviteHits(f.db, f.appId)).filter((hit) => hit.user_id === b.uid);
    expect({
      unbound,
      changes: changes.map((log) => [log.source, log.from_parent_id, log.to_parent_id]),
      hits: recorded.map((hit) => [hit.rule_id, hit.dimension, hit.value_hmac]),
    }).toEqual(
      unbound
        ? {
            unbound: true,
            changes: [['risk_same_device', b.parentId, null]],
            hits: [['inv_09_same_device', 'device_id_hash', b.hash]],
          }
        : { unbound: false, changes: [], hits: [] },
    );
    expect(invitee).toMatchObject(
      unbound
        ? { parent_id: null, parent_bind_source: null }
        : { parent_id: b.parentId, parent_bind_source: 'landing' },
    );
  });
});
