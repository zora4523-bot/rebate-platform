import { expect, it, vi } from 'vitest';
import { FIELD_CRYPTO_MESSAGES, FieldCryptoError, type FieldCrypto } from '../../platform/index.ts';
import { installSecretContext } from '../domain/device.ts';
import type { DevicesRepository, UnrevokedDevice } from '../infra/devices.repository.ts';
import { DeviceSigningKeysService } from './device-signing-keys.service.ts';

const DEVICE = '019a0000-0000-7000-8000-0000000000aa';
const SECRET = 'test-only.signing-keys.secret';

/** Ciphertext = context + secret, so a row whose cipher names another context fails. */
function fakeCrypto(): FieldCrypto & { decrypt: ReturnType<typeof vi.fn> } {
  const unused = (): never => {
    throw new Error('not used by the signing keys');
  };
  return {
    currentKeyVersion: 1,
    encrypt: unused,
    decrypt: vi.fn((ciphertext: string, context: string) => {
      if (!ciphertext.startsWith(`${context}|`))
        throw new FieldCryptoError('decrypt_failed', FIELD_CRYPTO_MESSAGES.decrypt_failed);
      return ciphertext.slice(context.length + 1);
    }),
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
    blindIndex: unused,
  };
}

function service(rows: Map<string, UnrevokedDevice>, crypto: FieldCrypto | undefined) {
  const findUnrevoked = vi.fn(async (id: string) => rows.get(id));
  const repository = { findUnrevoked } as unknown as DevicesRepository;
  return { keys: new DeviceSigningKeysService(repository, crypto), findUnrevoked };
}

function row(id: string, cipherContext = installSecretContext(id)): UnrevokedDevice {
  return { id, appId: 'couli', installSecretCipher: Buffer.from(`${cipherContext}|${SECRET}`) };
}

it('[BR-ID-09] answers null without a query for any value the server cannot have issued', async () => {
  const { keys, findUnrevoked } = service(new Map([[DEVICE, row(DEVICE)]]), fakeCrypto());
  for (const id of [
    '',
    'not-a-uuid',
    DEVICE.toUpperCase(),
    `{${DEVICE}}`,
    DEVICE.replaceAll('-', ''),
    ` ${DEVICE}`,
    `${DEVICE}\n`,
    `${DEVICE},${DEVICE}`,
  ]) {
    expect(await keys.findActive(id)).toBeNull();
  }
  expect(findUnrevoked).not.toHaveBeenCalled();
});

it('[BR-ID-09] a missing or revoked device is null; an issued one yields its row app_id and decrypted secret', async () => {
  const crypto = fakeCrypto();
  const { keys, findUnrevoked } = service(new Map([[DEVICE, row(DEVICE)]]), crypto);
  // The repository leaves revoked rows out (revoked_at IS NULL), exactly like missing ones.
  expect(await keys.findActive('019a0000-0000-7000-8000-0000000000bb')).toBeNull();
  expect(await keys.findActive(DEVICE)).toEqual({
    deviceId: DEVICE,
    appId: 'couli',
    installSecret: SECRET,
  });
  expect(crypto.decrypt).toHaveBeenLastCalledWith(
    `${installSecretContext(DEVICE)}|${SECRET}`,
    installSecretContext(DEVICE),
  );
  // No cache: every lookup reads the row again, so a revocation applies at once.
  expect(findUnrevoked).toHaveBeenCalledTimes(2);
});

it('[BR-ID-09] a ciphertext of another row or a process without keyring is an error, never "unknown device"', async () => {
  const other = '019a0000-0000-7000-8000-0000000000cc';
  const copied = service(
    new Map([[DEVICE, row(DEVICE, installSecretContext(other))]]),
    fakeCrypto(),
  );
  await expect(copied.keys.findActive(DEVICE)).rejects.toBeInstanceOf(FieldCryptoError);
  const keyless = service(new Map([[DEVICE, row(DEVICE)]]), undefined);
  const error = await keyless.keys.findActive(DEVICE).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(SECRET);
  // Without a keyring an unknown device is still answered as unknown.
  expect(await keyless.keys.findActive(other)).toBeNull();
});
