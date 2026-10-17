import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  idempotencyPostMissTransaction,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import { createStepUpCheck } from './step-up-verify.ts';

vi.mock('../../platform/index.ts', async (original) => ({
  ...(await original<typeof import('../../platform/index.ts')>()),
  idempotencyPostMissTransaction: vi.fn(),
}));

it('[AC-B1-02y#first-binding] first phone binding passes without withStepUp or a Redis reservation', async () => {
  const query = {
    withSchema: vi.fn().mockReturnThis(),
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue({ phone_hmac: null }),
  };
  vi.mocked(idempotencyPostMissTransaction).mockReturnValue(query as never);
  const namespace = vi.fn();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const check = createStepUpCheck({
    keys: {
      kid: 'unit',
      privateKey: pair.privateKey,
      publicKeys: new Map([['unit', pair.publicKey]]),
    },
    clock: new FixedClock('2026-10-17T00:00:00.000Z'),
    redis: { namespace } as unknown as RedisHandle,
    logger: { warn: vi.fn() } as unknown as RootLogger,
  });

  await expect(
    check({
      appId: 'couli',
      actor: { userId: '019a0000-0000-7000-8000-000000000010', deviceId: null, phoneHmac: null },
      method: 'POST',
      path: '/v1/me/phone',
      key: 'first-binding',
      body: {},
      traceId: 'first-binding',
    }),
  ).resolves.toBeUndefined();
  expect(query.withSchema).toHaveBeenCalledWith('app');
  expect(query.selectFrom).toHaveBeenCalledWith('users');
  expect(query.where.mock.calls).toEqual([
    ['app_id', '=', 'couli'],
    ['id', '=', '019a0000-0000-7000-8000-000000000010'],
  ]);
  expect(namespace).not.toHaveBeenCalled();
});
