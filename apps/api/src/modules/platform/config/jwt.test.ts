// B1-02zj (D10-255 ①) unit tests of the verify-only reading of the JWT_* variables (./jwt.ts).
// Keys are generated in the test; no .env file is read.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { readJwtKeyConfig, readJwtVerifyKeyConfig } from './jwt.ts';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

it('[D10-255] the verify-only reading keeps JWT_PUBLIC_KEY_PEM as given and needs no private key', () => {
  const keys = pair();
  const read = readJwtVerifyKeyConfig('staging', {
    JWT_KEY_ID: 'k1',
    JWT_PUBLIC_KEY_PEM: keys.publicPem,
  });
  expect(read).toEqual({
    jwt: { kid: 'k1', publicKeyPem: keys.publicPem, verificationKeys: {} },
    problems: [],
  });
});

it('[D10-255] from a private key only, the public key is derived and nothing private is kept', () => {
  const keys = pair();
  const read = readJwtVerifyKeyConfig('prod', {
    JWT_KEY_ID: 'k1',
    JWT_PRIVATE_KEY_PEM: keys.privatePem,
  });
  expect(read.problems).toEqual([]);
  expect(createPublicKey(read.jwt?.publicKeyPem ?? '').equals(keys.publicKey)).toBe(true);
  expect(Object.keys(read.jwt ?? {}).sort()).toEqual(['kid', 'publicKeyPem', 'verificationKeys']);
  expect(JSON.stringify(read.jwt)).not.toContain('PRIVATE KEY');
});

it('[D10-255] a malformed private key is a problem of the verify-only reading too, without its value', () => {
  const read = readJwtVerifyKeyConfig('staging', {
    JWT_KEY_ID: 'k1',
    JWT_PRIVATE_KEY_PEM: 'unit-secret-sentinel',
  });
  expect(read.jwt).toBeNull();
  expect(read.problems).toEqual([expect.stringMatching(/^JWT_PRIVATE_KEY_PEM: .*PKCS#8/)]);
  expect(read.problems.join(' ')).not.toContain('unit-secret-sentinel');
});

it('[D10-255] a key id without any key names JWT_PUBLIC_KEY_PEM; a key without a key id names its partner', () => {
  expect(readJwtVerifyKeyConfig('test', { JWT_KEY_ID: 'k1' }).problems).toEqual([
    expect.stringMatching(/^JWT_PUBLIC_KEY_PEM: must be set together with JWT_KEY_ID/),
  ]);
  const keys = pair();
  expect(readJwtVerifyKeyConfig('test', { JWT_PUBLIC_KEY_PEM: keys.publicPem }).problems).toEqual([
    'JWT_KEY_ID: must be set together with JWT_PUBLIC_KEY_PEM',
  ]);
  expect(readJwtVerifyKeyConfig('test', { JWT_PRIVATE_KEY_PEM: keys.privatePem }).problems).toEqual(
    ['JWT_KEY_ID: must be set together with JWT_PRIVATE_KEY_PEM'],
  );
});

it('[D10-255] the signing reading checks JWT_PUBLIC_KEY_PEM next to the private key (format and pair)', () => {
  const keys = pair();
  const other = pair();
  const base = { JWT_KEY_ID: 'k1', JWT_PRIVATE_KEY_PEM: keys.privatePem };
  expect(
    readJwtKeyConfig('staging', { ...base, JWT_PUBLIC_KEY_PEM: keys.publicPem }).problems,
  ).toEqual([]);
  expect(
    readJwtKeyConfig('staging', { ...base, JWT_PUBLIC_KEY_PEM: other.publicPem }).problems,
  ).toEqual(['JWT_PUBLIC_KEY_PEM: must be the public key of JWT_PRIVATE_KEY_PEM (one key pair)']);
  expect(
    readJwtKeyConfig('staging', { ...base, JWT_PUBLIC_KEY_PEM: 'not-a-key' }).problems,
  ).toEqual([expect.stringMatching(/^JWT_PUBLIC_KEY_PEM: .*SPKI/)]);
});

it('[D10-255] the previous-key clash names both sources of the current key', () => {
  const keys = pair();
  const read = readJwtVerifyKeyConfig('staging', {
    JWT_KEY_ID: 'k1',
    JWT_PUBLIC_KEY_PEM: keys.publicPem,
    JWT_VERIFY_KEYS_JSON: JSON.stringify({ k1: keys.publicPem }),
  });
  expect(read.jwt).toBeNull();
  expect(read.problems).toEqual([
    expect.stringMatching(/^JWT_VERIFY_KEYS_JSON: must not contain JWT_KEY_ID/),
  ]);
});
