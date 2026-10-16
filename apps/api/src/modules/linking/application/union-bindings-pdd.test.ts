// Unit test of the GET /v1/unions/bindings Pinduoduo refresh without a database (B1-06zb): the
// self_buy slot is asked for the union account in use (the unreleased binding's) and another
// account's slot never builds the filing query. The SQL runs against PostgreSQL in the rule tests
// (test/spec/linking/bindings-pdd-account).
import { describe, expect, it, vi } from 'vitest';
import type { UnionPidRow } from '../../union/index.ts';
import {
  createUnionBindingsWithPddQuery,
  type PddQueryBindingsOptions,
} from './union-bindings-pdd.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';
const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-000000000001';
const ACCOUNT_A = '0199a3b4-5c6d-7000-8000-0000000000a1';
const ACCOUNT_B = '0199a3b4-5c6d-7000-8000-0000000000a2';

function setup(slotAccount: string) {
  const getActivePid = vi.fn((input: { readonly unionAccountId?: string }) => {
    void input;
    return Promise.resolve({
      app_id: APP,
      platform: 'pdd',
      pid_scene: 'self_buy',
      status: 'active',
      pid: `synthetic-pid-${slotAccount.slice(-2)}`,
      union_account_id: slotAccount,
    } as unknown as UnionPidRow);
  });
  const registryGet = vi.fn(() => {
    throw new Error('the registry must not be asked');
  });
  const warn = vi.fn();
  const transaction = vi.fn(() => {
    throw new Error('nothing is written');
  });
  const options = {
    db: { transaction },
    callerContext: { current: () => Promise.resolve({ appId: APP, userId: USER, deviceId: null }) },
    reads: {
      binding: (_app: string, _user: string, platform: string) =>
        Promise.resolve(
          platform === 'pdd'
            ? { status: 'pending_auth', accountId: ACCOUNT_A }
            : { status: 'unbound', accountId: null },
        ),
      authAccountId: (_app: string, _platform: string, bound: string | null) =>
        Promise.resolve(bound),
      siteAuthAvailable: () => Promise.resolve(true),
    },
    logger: { warn },
    registry: { get: registryGet },
    pids: { getActivePid },
    attrCodes: { attrCode: () => Promise.resolve('abcd1234') },
  } as unknown as PddQueryBindingsOptions;
  return {
    service: createUnionBindingsWithPddQuery(options),
    getActivePid,
    registryGet,
    warn,
    transaction,
  };
}

describe('GET bindings pdd refresh by the account in use (B1-06zb)', () => {
  it('[AC-B1-06zb] another account slot answered for the account in use is never queried', async () => {
    const { service, getActivePid, registryGet, warn, transaction } = setup(ACCOUNT_B);
    const answer = await service.list({ traceId: TRACE });
    expect(answer.status).toBe(200);
    expect(getActivePid.mock.calls.map(([input]) => input.unionAccountId)).toEqual([ACCOUNT_A]);
    expect(registryGet).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([fields]) => (fields as { event: string }).event)).toEqual([
      'linking.bindings.no_active_pid',
    ]);
  });
});
