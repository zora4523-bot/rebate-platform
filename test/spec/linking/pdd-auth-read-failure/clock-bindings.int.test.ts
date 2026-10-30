// B1-22u (编排裁定 D10-434 ②; BR-ID-24 ④, B1-22b), review r1 S1: POST /v1/unions/taobao/bindings
// judges the site authorization of the account in use against the injected Clock. The service is
// the one the linking module builds for UNION_BINDINGS (the whole api app over the bindings kit,
// CLOCK = the kit's FixedClock; only the credential exchanger is replaced), in both directions:
// - FixedClock earlier than the wall clock, auth_expires_at between them: not reached by the
//   injected clock → the submission is accepted (the wall clock would answer auth_unavailable);
// - FixedClock later than the wall clock, auth_expires_at between them: reached by the injected
//   clock → 30101 / 30102 auth_unavailable, the state and the bindings untouched, no exchange (the
//   wall clock would accept).
import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { SystemClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { accepted, rejected } from '../bindings/assertions.ts';
import { client, web, type Client } from '../bindings/client.ts';
import { ACCOUNT_NAME, suite, type Fixture } from '../bindings/kit.ts';
import { binding, bindings, snapshot, state, states } from '../bindings/records.ts';
import { DAY_MS, shifted } from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

/** Earlier than the wall clock. */
const PAST = '2026-10-08T04:05:06.789Z';
/** Later than the wall clock. */
const FUTURE = '2031-05-06T07:08:09.000Z';

type Status = 'unbound' | 'invalid';

/** The app's only Taobao account (so the one in use), site authorization active until `expiry`. */
async function account(f: Fixture, c: Client, expiry: Date): Promise<string> {
  const row = await f.db
    .insertInto('union_accounts')
    .values({
      id: randomUUID(),
      app_id: c.appId,
      platform: 'taobao',
      account_name: ACCOUNT_NAME,
      status: 'active',
      auth_status: 'active',
      auth_expires_at: expiry,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The user (unbound, or with an invalid binding on the account), its account and a bind state. */
async function arrange(f: Fixture, at: string, offset: number, status: Status) {
  f.clock.set(at);
  const expiry = shifted(f.clock, offset);
  const c = await client(f);
  const accountId = await account(f, c, expiry);
  const original = status === 'invalid' ? await binding(f, c, accountId, { status }) : undefined;
  const s = await state(f, c);
  return { c, accountId, expiry, original, s };
}

it.each(['unbound', 'invalid'] as const)(
  '[B1-22u] bindings %s：注入的 FixedClock 早于系统时间，站长授权到期时刻在两者之间 → 按注入时钟未到期，照常绑定',
  async (status) => {
    const f = use();
    const { c, accountId, expiry, original, s } = await arrange(f, PAST, DAY_MS, status);
    // The window separates the two clocks: the wall clock is already past this instant.
    expect(new SystemClock().now().getTime()).toBeGreaterThan(expiry.getTime());
    await accepted(await c.post(web(s.state)));
    expect(await bindings(f, c)).toEqual([
      expect.objectContaining({
        ...(original === undefined ? {} : { id: original.id }),
        user_id: c.uid,
        platform: 'taobao',
        union_account_id: accountId,
        status: 'active',
      }),
    ]);
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(f.exchange).toHaveBeenCalledOnce();
  },
  60_000,
);

it.each(['unbound', 'invalid'] as const)(
  '[B1-22u] bindings %s：注入的 FixedClock 晚于系统时间，站长授权到期时刻在两者之间 → 按注入时钟已到期，auth_unavailable 且不消费 state、不改绑定',
  async (status) => {
    const f = use();
    const { c, expiry, s } = await arrange(f, FUTURE, -DAY_MS, status);
    // The window separates the two clocks: the wall clock has not reached this instant yet.
    expect(new SystemClock().now().getTime()).toBeLessThan(expiry.getTime());
    const before = await snapshot(f, c);
    const response = await c.post(web(s.state));
    await rejected(response, status === 'invalid' ? 30102 : 30101, 'auth_unavailable');
    expect(await snapshot(f, c)).toEqual(before);
    expect(f.exchange).not.toHaveBeenCalled();
  },
  60_000,
);
