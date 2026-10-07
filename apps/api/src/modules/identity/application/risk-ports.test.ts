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
    checkRegistration: vi.fn<BlocklistService['checkRegistration']>(async () => null),
    recordHit: vi.fn<BlocklistService['recordHit']>(async () => ({ ref_id: 'r' })),
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

it('[AC-B1-03d#15] registration port passes trx and both dimensions, strips ref_id', async () => {
  const { risk, ports } = fakes();
  risk.checkRegistration.mockResolvedValueOnce(HIT);
  const trx = {} as Transaction<DB>;
  const result = await ports.login.registrationBlocklist!(trx, {
    app_id: 'a',
    phone: PHONE,
    phone_hmac: 'p',
    device_hash: 'h',
  });
  expect(result).toEqual({ code: 44001, data: { risk_msg_code: 'blocklist.other' } });
  expect(risk.checkRegistration).toHaveBeenCalledWith(trx, {
    app_id: 'a',
    phone_hmac: 'p',
    device_hash: 'h',
    related_phone: PHONE,
  });
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
