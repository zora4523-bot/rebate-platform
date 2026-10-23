import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import type { Fixture } from '../open-taobao/kit.ts';

// Task B1-22m (BR-ATTR-05 细则「open 业务校验的先后」④ → ⑥ → ⑦; D10-239 T2 + T3c) is the rule
// source. The open and the convert fixtures share these fields; all rows are synthetic.
export type Base = Pick<
  Fixture,
  'db' | 'f' | 'appId' | 'account' | 'device' | 'getActivePid' | 'sessions'
>;

/**
 * The account this open uses has no active promotion slot in these pid_scenes. The fixture has a
 * single union account, so no other account's slot exists either (nothing can stand in).
 */
export function withoutSlots(f: Base, scenes: readonly string[]) {
  const original = f.getActivePid.getMockImplementation()!;
  f.getActivePid.mockImplementation(async (query) =>
    scenes.includes(query.pidScene) ? null : original(query),
  );
}

/** BR-ID-24: the site authorization of the fixture's only Taobao account has expired. */
export async function expireSite(f: Base) {
  await f.db
    .updateTable('union_accounts')
    .set({ auth_status: 'expired' })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.account)
    .execute();
}

/**
 * D10-239 T3c: the app has no Taobao union account at all (and so no slot of any scene). couli_app
 * may not delete union_accounts, so the fixture's only account (nothing references it yet) is moved
 * to another platform; an account of another platform never counts for Taobao.
 */
export async function dropAccounts(f: Base) {
  f.getActivePid.mockResolvedValue(null);
  await f.db
    .updateTable('union_accounts')
    .set({ platform: 'jd' })
    .where('app_id', '=', f.appId)
    .where('platform', '=', 'taobao')
    .execute();
}

/** A Taobao account with a valid site authorization and still no active slot of any scene. */
export async function addAccount(f: Base) {
  const id = randomUUID();
  await f.db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: f.appId,
      platform: 'taobao',
      account_name: 'synthetic-late-account',
      status: 'active',
      auth_status: 'active',
      created_at: f.f.clock.now(),
      updated_at: f.f.clock.now(),
    })
    .execute();
  return id;
}

/** BR-ID-31: the user is banned (a session still reaching the open asks to log in). */
export async function ban(f: Base, userId: string) {
  await f.db
    .updateTable('user_risk_state')
    .set({ state: 'banned', reason_category: 'other', changed_at: f.f.clock.now() })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .execute();
}

/** A refusal without any jump, auth entry or state; `data` (when given) is the whole data. */
export function refused(result: HandlerResult, code: number, status: number, data?: unknown) {
  expect(result).toMatchObject({ status, envelope: { code } });
  const body = (result.envelope.data ?? {}) as Record<string, unknown>;
  for (const key of ['jump', 'auth_url', 'state', 'auth_methods'])
    expect(body).not.toHaveProperty(key);
  if (data !== undefined) expect(result.envelope.data).toEqual(data);
}

/** 30101 / 30102 with auth_url and a one-time state bound to the user, device and the link. */
export async function stateIssued(
  result: HandlerResult,
  f: Base,
  code: 30101 | 30102,
  userId: string,
  linkId: string,
) {
  expect(result).toMatchObject({ status: 422, envelope: { code } });
  const data = result.envelope.data as {
    auth_url: string;
    state: string;
    auth_methods: string[];
  };
  expect(data).toMatchObject({
    auth_url: expect.stringMatching(/^https:\/\//),
    state: expect.any(String),
    auth_methods: ['web_code'],
  });
  expect(data).not.toHaveProperty('reason');
  expect(data).not.toHaveProperty('jump');
  expect(new URL(data.auth_url).searchParams.get('state')).toBe(data.state);
  expect(await f.sessions()).toContainEqual(
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: userId,
      device_id: f.device,
      platform: 'taobao',
      link_id: linkId,
      used_at: null,
    }),
  );
}
