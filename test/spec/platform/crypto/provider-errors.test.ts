// Rule tests for 规划/08 BR-ID-33 (KMS 信封加密) at the provider's identity: the three entries that
// take a KeyProvider — createWrappedKeyring, rotateDataKey and openFieldCrypto — read
// `provider.keyId` before anything else (the keyring's key_id must match it). Two cases the
// other rule tests leave out:
// - the provider is null or undefined: the master key cannot be identified, so the call rejects
//   with invalid_keyring, exactly the contract error;
// - reading `keyId` throws (a KMS client may compute it and fail with an error that quotes its
//   configuration, a phone number or key bytes): the call rejects with key_provider_failed and
//   keeps nothing of the provider's error, whatever was thrown — a plain Error with extra
//   properties, a FieldCryptoError with this or another code, a non-Error value — and wherever
//   the getter lives (own accessor, class prototype, Proxy trap).
// In both cases each entry returns a promise (no synchronous throw), the error is exactly the
// contract's (errorProblems: FieldCryptoError, fixed message, plain stack, no cause, no other
// property), and no key reaches a provider whose master key could not be identified (wrapKey
// and unwrapKey are never called). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FieldCryptoError,
  type KeyProvider,
  LocalKeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { errorProblems, leaksIn, testKey } from './kit.ts';

const MASTER_LABEL = 232;
const SECRET_KEY_LABEL = 233;
const PHONE = '13877776666';

type Entry = (provider: KeyProvider) => Promise<unknown>;

/** The three entries that take a provider, on a valid keyring of `local`. */
function entries(doc: WrappedKeyring): Record<string, Entry> {
  return {
    createWrappedKeyring: (provider) => createWrappedKeyring(provider),
    rotateDataKey: (provider) => rotateDataKey(doc, provider),
    openFieldCrypto: (provider) => openFieldCrypto(doc, provider),
  };
}

/**
 * Calls `entry` and reports what happened: whether it returned a promise (instead of throwing
 * synchronously or returning something else) and the value it rejected with.
 */
async function outcome(
  entry: Entry,
  provider: KeyProvider,
): Promise<{ promise: boolean; error: unknown }> {
  let result: unknown;
  try {
    result = entry(provider);
  } catch (error) {
    return { promise: false, error };
  }
  if (!(result instanceof Promise)) return { promise: false, error: 'returned a non-promise' };
  try {
    await result;
  } catch (error) {
    return { promise: true, error };
  }
  return { promise: true, error: 'the call resolved' };
}

/** wrapKey / unwrapKey that count their calls and forward to a working LocalKeyProvider. */
function countingMethods(local: LocalKeyProvider, calls: { count: number }) {
  return {
    wrapKey(plainKey: Uint8Array): Promise<string> {
      calls.count += 1;
      return local.wrapKey(plainKey);
    },
    unwrapKey(wrappedKey: string): Promise<Uint8Array> {
      calls.count += 1;
      return local.unwrapKey(wrappedKey);
    },
  };
}

it('[AC-B1-01zn#1][BR-ID-33] provider 为 null 或 undefined：createWrappedKeyring、rotateDataKey、openFieldCrypto 都返回 promise 并以 invalid_keyring 拒绝，错误是 FieldCryptoError、固定文案、普通堆栈、没有 cause 与附加属性', async () => {
  const local = new LocalKeyProvider(testKey(MASTER_LABEL), 'errors-a');
  const doc = await createWrappedKeyring(local);
  const before = JSON.stringify(doc);
  const results: Record<string, { promise: boolean; problems: string[] }> = {};
  for (const [label, provider] of [
    ['null', null],
    ['undefined', undefined],
  ] as const) {
    for (const [name, entry] of Object.entries(entries(doc))) {
      const { promise, error } = await outcome(entry, provider as unknown as KeyProvider);
      results[`${name}-${label}`] = { promise, problems: errorProblems(error, 'invalid_keyring') };
    }
  }
  expect({ results, docUnchanged: JSON.stringify(doc) === before }).toEqual({
    results: Object.fromEntries(
      Object.keys(results).map((name) => [name, { promise: true, problems: [] }]),
    ),
    docUnchanged: true,
  });
  expect(Object.keys(results)).toHaveLength(6);
});

it('[AC-B1-01zn#2][BR-ID-33] provider.keyId 的 getter 抛错（普通 Error 带附加属性、同码或别的码的 FieldCryptoError、非 Error 值；getter 在对象自身、类原型或 Proxy 上），错误里带着手机号与密钥：三个入口都返回 promise 并以 key_provider_failed 拒绝，错误确切且找不到那些值，wrapKey / unwrapKey 一次都没被调用', async () => {
  const local = new LocalKeyProvider(testKey(MASTER_LABEL), 'errors-b');
  const doc = await createWrappedKeyring(local);
  const before = JSON.stringify(doc);
  const secretKey = testKey(SECRET_KEY_LABEL);
  const secret = `kms config for ${PHONE} key=${secretKey.toString('hex')}`;

  const thrown: Record<string, () => unknown> = {
    error: () => Object.assign(new Error(secret), { request: secret, cause: secret }),
    'field-crypto-error-same-code': () =>
      Object.assign(new FieldCryptoError('key_provider_failed', secret), { request: secret }),
    'field-crypto-error-other-code': () => new FieldCryptoError('invalid_keyring', secret),
    'plain-object': () => ({ message: secret, key: secretKey }),
    string: () => secret,
  };

  type Shape = 'own-getter' | 'prototype-getter' | 'proxy';
  function failingProvider(shape: Shape, make: () => unknown, calls: { count: number }) {
    const methods = countingMethods(local, calls);
    if (shape === 'own-getter') {
      return {
        get keyId(): string {
          throw make();
        },
        ...methods,
      } as KeyProvider;
    }
    if (shape === 'prototype-getter') {
      class Kms {
        get keyId(): string {
          throw make();
        }
        wrapKey(plainKey: Uint8Array): Promise<string> {
          return methods.wrapKey(plainKey);
        }
        unwrapKey(wrappedKey: string): Promise<Uint8Array> {
          return methods.unwrapKey(wrappedKey);
        }
      }
      return new Kms() as KeyProvider;
    }
    return new Proxy(
      { keyId: local.keyId, ...methods },
      {
        get(target, property, receiver): unknown {
          if (property === 'keyId') throw make();
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    ) as KeyProvider;
  }

  const results: Record<string, { promise: boolean; problems: string[]; providerCalls: number }> =
    {};
  for (const shape of ['own-getter', 'prototype-getter', 'proxy'] as const) {
    for (const [kind, make] of Object.entries(thrown)) {
      for (const [name, entry] of Object.entries(entries(doc))) {
        const calls = { count: 0 };
        const { promise, error } = await outcome(entry, failingProvider(shape, make, calls));
        results[`${name}-${shape}-${kind}`] = {
          promise,
          problems: [
            ...errorProblems(error, 'key_provider_failed'),
            ...leaksIn(error, { secret, phone: PHONE, key: secretKey }),
          ],
          providerCalls: calls.count,
        };
      }
    }
  }
  expect({ results, docUnchanged: JSON.stringify(doc) === before }).toEqual({
    results: Object.fromEntries(
      Object.keys(results).map((name) => [name, { promise: true, problems: [], providerCalls: 0 }]),
    ),
    docUnchanged: true,
  });
  expect(Object.keys(results)).toHaveLength(3 * 5 * 3);
});

it('[AC-B1-01zn#3][BR-ID-33] 对照：同一个 provider 的 keyId 改为正常返回后，三个入口都成功——上面的拒绝来自 keyId，不是测试搭的 provider 本身不能用', async () => {
  const local = new LocalKeyProvider(testKey(MASTER_LABEL), 'errors-c');
  const doc = await createWrappedKeyring(local);
  const calls = { count: 0 };
  const methods = countingMethods(local, calls);
  const providers: Record<string, KeyProvider> = {
    'own-getter': {
      get keyId(): string {
        return local.keyId;
      },
      ...methods,
    },
    proxy: new Proxy({ keyId: local.keyId, ...methods }, {}) as KeyProvider,
  };
  const results: Record<string, string> = {};
  for (const [shape, provider] of Object.entries(providers)) {
    for (const [name, entry] of Object.entries(entries(doc))) {
      const { promise, error } = await outcome(entry, provider);
      results[`${name}-${shape}`] = promise ? String(error) : 'not a promise';
    }
  }
  expect(results).toEqual(
    Object.fromEntries(Object.keys(results).map((name) => [name, 'the call resolved'])),
  );
  expect(Object.keys(results)).toHaveLength(6);
  expect(calls.count).toBeGreaterThan(0);
});
