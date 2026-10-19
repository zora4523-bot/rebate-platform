import { expect, it } from 'vitest';

it.each(['local', 'test'])('[AC-B1-13f#50] %s 装配演示 BIN 和三要素假实现', async (appEnv) => {
  const adapters =
    await import('../../../../apps/api/src/modules/identity/infra/fake-bank-card-verifier.ts');
  const bin = adapters.createCardBin(appEnv);
  const verifier = adapters.createBankCardVerifier(appEnv);
  expect(bin).not.toBeNull();
  expect(verifier).not.toBeNull();
  // Fictional prefix is deliberately distinct from real bank data (task §9.2 #7).
  expect(await bin!.lookup('9900010000000019')).toMatchObject({
    card_type: 'debit',
    bank_name: expect.stringContaining('示例'),
    bin: '990001',
  });
  expect(await bin!.lookup('6222021234567890123')).toBeNull();
  expect(
    await verifier!.verify({
      vendor_request_id: 'demo-only-1',
      name: '示例姓名',
      id_no: 'demo-id',
      card_no: '9900010000000019',
    }),
  ).toBe('match');
  expect(await verifier!.query('demo-only-1')).toBe('match');
});

it.each(['staging', 'prod'])(
  '[AC-B1-13f#51] %s 未接供应商时装配 null，禁止创建假供应商',
  async (appEnv) => {
    const adapters =
      await import('../../../../apps/api/src/modules/identity/infra/fake-bank-card-verifier.ts');
    expect(adapters.createCardBin(appEnv)).toBeNull();
    expect(adapters.createBankCardVerifier(appEnv)).toBeNull();
    expect(() => adapters.createFakeCardBin(appEnv)).toThrow();
    expect(() => adapters.createFakeBankCardVerifier(appEnv)).toThrow();
  },
);
