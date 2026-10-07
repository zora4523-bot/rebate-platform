import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { FieldCrypto } from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';
import { identityRiskPorts } from './risk-ports.ts';

const PHONE = '13812345678';
const HIT = { code: 44001 as const, data: { risk_msg_code: 'blocklist.other' }, ref_id: 'r' };

function fakes() {
  const risk = {
    check: vi.fn<BlocklistService['check']>(async () => HIT),
    checkRegistration: vi.fn<BlocklistService['checkRegistration']>(async () => {
      throw new Error('the login path must not record inside its transaction');
    }),
    matchRegistration: vi.fn<BlocklistService['matchRegistration']>(async () => null),
    recordHit: vi.fn<BlocklistService['recordHit']>(async () => ({ ref_id: 'r' })),
    recordHits: vi.fn<BlocklistService['recordHits']>(async () => ({ ref_id: 'r' })),
    allowBlockedRegistration: vi.fn<BlocklistService['allowBlockedRegistration']>(
      async () => false,
    ),
  };
  const crypto = { blindIndex: (value: string, context: string) => `${context}:${value}` };
  return { risk, ports: identityRiskPorts(risk, crypto as unknown as FieldCrypto) };
}

it('[AC-B1-03d#14] login-purpose send checks the phone as a register request, answer has no ref_id', async () => {
  const { risk, ports } = fakes();
  const result = await ports.smsHooks.phoneBlocklist!({
    app_id: 'a',
    phone: PHONE,
    purpose: 'login',
  });
  expect(result).toEqual({
    code: 44001,
    kind: 'phone_blocklist',
    data: { risk_msg_code: 'blocklist.other' },
  });
  expect(risk.check).toHaveBeenCalledWith({
    app_id: 'a',
    dimension: 'phone',
    value: PHONE,
    related_phone: PHONE,
    request_type: 'register',
  });
});

it('[AC-B1-03d#23] bind send has no request type; a miss answers null', async () => {
  const { risk, ports } = fakes();
  risk.check.mockResolvedValueOnce(null);
  expect(
    await ports.smsHooks.phoneBlocklist!({ app_id: 'a', phone: PHONE, purpose: 'bind' }),
  ).toBeNull();
  expect(risk.check.mock.calls[0]?.[0].request_type).toBeNull();
});

it('[AC-B1-03d#18] prefix refusal records SMS_BLOCKED_PREFIX on the phone blind index', async () => {
  const { risk, ports } = fakes();
  await ports.smsHooks.blockedPrefix!({ app_id: 'a', phone: PHONE, purpose: 'login' });
  expect(risk.recordHit).toHaveBeenCalledWith({
    app_id: 'a',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'phone_prefix',
    value_hmac: `users.phone:${PHONE}`,
    rule_id: 'SMS_BLOCKED_PREFIX',
  });
});

it('[AC-B1-03d#20] device-limit refusal records DEVICE_REGISTER_LIMIT on the device hash', async () => {
  const { risk, ports } = fakes();
  await ports.login.recordDeviceLimit!({
    app_id: 'a',
    device_hash: 'h',
    count: 3,
    limit: 3,
    phone: PHONE,
  });
  expect(risk.recordHit).toHaveBeenCalledWith({
    app_id: 'a',
    request_type: 'register',
    related_phone: PHONE,
    dimension: 'device',
    value_hmac: 'h',
    rule_id: 'DEVICE_REGISTER_LIMIT',
  });
});

it('[AC-B1-03d#15] registration port only matches in trx; the hits are written by record, later', async () => {
  const { risk, ports } = fakes();
  const hits = [
    { dimension: 'phone', value_hmac: 'p', rule_id: 'BLACKLIST_PHONE' },
    { dimension: 'device', value_hmac: 'h', rule_id: 'BLACKLIST_DEVICE' },
  ];
  risk.matchRegistration.mockResolvedValueOnce({
    code: 44001,
    data: { risk_msg_code: 'blocklist.other' },
    hits,
  });
  const trx = {} as Transaction<DB>;
  const result = await ports.login.registrationBlocklist!(trx, {
    app_id: 'a',
    phone: PHONE,
    phone_hmac: 'p',
    device_hash: 'h',
  });
  expect(result).toMatchObject({ code: 44001, data: { risk_msg_code: 'blocklist.other' } });
  expect(Object.keys(result!).sort()).toEqual(['code', 'data', 'record']);
  expect(risk.matchRegistration).toHaveBeenCalledWith(trx, {
    app_id: 'a',
    phone_hmac: 'p',
    device_hash: 'h',
    related_phone: PHONE,
  });
  // Nothing written while the caller's transaction is open.
  expect(risk.checkRegistration).not.toHaveBeenCalled();
  expect(risk.recordHits).not.toHaveBeenCalled();
  await result!.record!();
  expect(risk.recordHits).toHaveBeenCalledExactlyOnceWith(
    { app_id: 'a', request_type: 'register', related_phone: PHONE },
    hits,
  );
  const input = {
    app_id: 'a',
    device_hash: 'h',
    count: 3,
    limit: 3,
    phone_hmac: 'p',
    third_party_digest: null,
  };
  expect(await ports.registration.allowBlockedRegistration!(trx, input)).toBe(false);
  expect(risk.allowBlockedRegistration).toHaveBeenCalledWith(trx, input);
});

it('[AC-B1-03d#15] registration port: a miss answers null and records nothing', async () => {
  const { risk, ports } = fakes();
  const trx = {} as Transaction<DB>;
  expect(
    await ports.login.registrationBlocklist!(trx, { app_id: 'a', phone: PHONE, phone_hmac: 'p' }),
  ).toBeNull();
  expect(risk.matchRegistration).toHaveBeenCalledWith(trx, {
    app_id: 'a',
    phone_hmac: 'p',
    related_phone: PHONE,
  });
  expect(risk.recordHits).not.toHaveBeenCalled();
});

it('[AC-B1-03d#14][BR-ID-31] step_up send for account_deletion skips the blocklist: no check, no hit', async () => {
  const { risk, ports } = fakes();
  expect(
    await ports.smsHooks.phoneBlocklist!({
      app_id: 'a',
      phone: PHONE,
      purpose: 'step_up',
      action: 'account_deletion',
    }),
  ).toBeNull();
  expect(risk.check).not.toHaveBeenCalled();
  expect(risk.recordHit).not.toHaveBeenCalled();
});

it.each([
  { purpose: 'step_up' as const, action: 'phone_change' },
  { purpose: 'step_up' as const, action: undefined },
  { purpose: 'bind' as const, action: 'account_deletion' },
  { purpose: 'login' as const, action: 'account_deletion' },
])(
  '[AC-B1-03d#14] other sends ($purpose / $action) still check the blocklist',
  async ({ purpose, action }) => {
    const { risk, ports } = fakes();
    const result = await ports.smsHooks.phoneBlocklist!({
      app_id: 'a',
      phone: PHONE,
      purpose,
      ...(action === undefined ? {} : { action }),
    });
    expect(result).toMatchObject({ code: 44001, kind: 'phone_blocklist' });
    expect(risk.check).toHaveBeenCalledOnce();
  },
);
