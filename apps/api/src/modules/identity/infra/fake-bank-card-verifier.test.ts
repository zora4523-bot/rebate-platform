import { expect, it } from 'vitest';
import {
  createBankCardVerifier,
  createCardBin,
  createFakeBankCardVerifier,
  createFakeCardBin,
} from './fake-bank-card-verifier.ts';

it.each(['local', 'test'])(
  '[AC-B1-13f] %s: the demo BIN table knows only fictional 99000x prefixes',
  async (appEnv) => {
    const bin = createFakeCardBin(appEnv);
    expect(await bin.lookup('9900010000000019')).toEqual({
      card_type: 'debit',
      bank_name: '示例银行',
      bin: '990001',
    });
    expect(await bin.lookup('9900090000000013')).toMatchObject({
      card_type: 'credit',
      bin: '990009',
    });
    expect(await bin.lookup('6222021234567890123')).toBeNull();
    expect(createCardBin(appEnv)).not.toBeNull();
  },
);

it('[AC-B1-13f] the fake verifier matches and answers query only for its own request ids', async () => {
  const verifier = createFakeBankCardVerifier('test');
  expect(await verifier.query('never-sent')).toBe('not_found');
  expect(
    await verifier.verify({
      vendor_request_id: 'demo-1',
      name: '示例姓名',
      id_no: 'demo-id',
      card_no: '9900010000000019',
    }),
  ).toBe('match');
  expect(await verifier.query('demo-1')).toBe('match');
  // Separate instances keep separate answers (each application assembly owns one).
  expect(await createFakeBankCardVerifier('test').query('demo-1')).toBe('not_found');
  expect(createBankCardVerifier('local')).not.toBeNull();
});

it.each(['staging', 'prod', 'production', ''])(
  '[AC-B1-13f] APP_ENV %j assembles no BIN source or verifier and refuses the fakes',
  (appEnv) => {
    expect(createCardBin(appEnv)).toBeNull();
    expect(createBankCardVerifier(appEnv)).toBeNull();
    expect(() => createFakeCardBin(appEnv)).toThrow(/local or test/);
    expect(() => createFakeBankCardVerifier(appEnv)).toThrow(/local or test/);
  },
);
