// Rule tests for 规划/08 BR-ID-33 (KMS 信封加密): key bytes must not land in Node's shared Buffer
// pool. Small `Buffer.from(…)`, `Buffer.concat(…)` and `Buffer.allocUnsafe(…)` results are views
// into one pooled ArrayBuffer of `Buffer.poolSize` bytes that later, unrelated Buffers share: a
// key copied there stays readable through any of them (`someBuffer.buffer`) until overwritten,
// and erasing the key's own view does not erase the pool. So the master key, the data keys, the
// blind-index key and every unwrapped key must live only in allocations of their own.
//
// What is observable from outside: the key bytes handed to `provider.wrapKey`, the bytes
// `LocalKeyProvider.unwrapKey` returns, and the pool itself — `Buffer.from('x').buffer` is the
// current pool, so probing it around every operation keeps each pool that was in use (a pool
// replaced along the way included), and searching those pools for the keys' bytes shows whether
// any copy was left there. The test keeps its own key copies in `new Uint8Array(…)` (never
// `Buffer.from(…)`, which would put them into the pool itself); keys derive from testKey (a hash
// digest, an allocation of its own) or randomBytes (same).
// Top-level it() only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { expect, it } from 'vitest';
import {
  type KeyProvider,
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { KEY_BYTES, SAMPLES, testKey } from './kit.ts';

const MASTER_LABEL = 230;
const CONTROL_LABEL = 231;

/** Every pool seen so far. */
const pools = new Set<ArrayBufferLike>();

/** Remembers the pool in use right now. */
function probePool(): void {
  pools.add(Buffer.from('x').buffer);
}

/**
 * Why `view` does not own its memory: an empty list when it starts at offset 0 of an ArrayBuffer
 * (not SharedArrayBuffer) exactly as long as itself that is none of the pools seen so far.
 */
function ownershipProblems(view: Uint8Array): string[] {
  const problems: string[] = [];
  if (view.byteOffset !== 0) problems.push(`byteOffset ${String(view.byteOffset)}`);
  if (view.buffer.byteLength !== view.byteLength) {
    problems.push(
      `buffer.byteLength ${String(view.buffer.byteLength)} != byteLength ${String(view.byteLength)}`,
    );
  }
  if (types.isSharedArrayBuffer(view.buffer)) problems.push('shared memory');
  if (pools.has(view.buffer)) problems.push('is a Buffer pool');
  return problems;
}

/** Names of the keys whose bytes appear in any pool seen so far. */
function keysInPools(keys: Readonly<Record<string, Uint8Array>>): string[] {
  const found: string[] = [];
  for (const [name, key] of Object.entries(keys)) {
    const needle = Buffer.from(key.buffer, key.byteOffset, key.byteLength);
    for (const pool of pools) {
      if (Buffer.from(pool).includes(needle)) {
        found.push(name);
        break;
      }
    }
  }
  return found;
}

/** Copy of `bytes` in an allocation of its own (not the pool). */
function copyOf(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * A KeyProvider around a LocalKeyProvider that records, at the moment of each call, the shape
 * and a copy of every plain key it is handed and of every key it returns, probing the pool on
 * the way. `viewOffset` > 0 returns unwrapped keys as a view into a larger ArrayBuffer instead
 * (a provider may hand out such views; the module must still keep only its own copy).
 */
class RecordingProvider implements KeyProvider {
  readonly keyId: string;
  readonly #inner: LocalKeyProvider;
  readonly #viewOffset: number;
  /** For each wrapKey call: problems of the argument, its ArrayBuffer and a copy of the key. */
  readonly handed: { problems: string[]; buffer: ArrayBufferLike; copy: Uint8Array }[] = [];
  /** A copy of every key unwrapKey returned. */
  readonly returned: Uint8Array[] = [];

  constructor(inner: LocalKeyProvider, viewOffset = 0) {
    this.keyId = inner.keyId;
    this.#inner = inner;
    this.#viewOffset = viewOffset;
  }

  wrapKey(plainKey: Uint8Array): Promise<string> {
    probePool();
    this.handed.push({
      problems: ownershipProblems(plainKey),
      buffer: plainKey.buffer,
      copy: copyOf(plainKey),
    });
    const wrapped = this.#inner.wrapKey(plainKey);
    probePool();
    return wrapped;
  }

  async unwrapKey(wrappedKey: string): Promise<Uint8Array> {
    probePool();
    const key = await this.#inner.unwrapKey(wrappedKey);
    probePool();
    this.returned.push(copyOf(key));
    if (this.#viewOffset === 0) return key;
    const big = new ArrayBuffer(this.#viewOffset + key.byteLength + this.#viewOffset);
    const view = new Uint8Array(big, this.#viewOffset, key.byteLength);
    view.set(key);
    key.fill(0);
    return view;
  }
}

it('[AC-B1-01zn#1][BR-ID-33] 交给 provider.wrapKey 的每把新密钥（新建时的数据密钥与盲索引密钥、每次轮换的数据密钥）都是独占内存的 32 字节：byteOffset 为 0、buffer.byteLength 等于 32、不是共享 Buffer 池，三把密钥各用各的 ArrayBuffer', async () => {
  probePool();
  const provider = new RecordingProvider(new LocalKeyProvider(testKey(MASTER_LABEL), 'pool-a'));
  const created = await createWrappedKeyring(provider);
  probePool();
  await rotateDataKey(created, provider);
  probePool();
  expect({
    calls: provider.handed.length,
    lengths: provider.handed.map((call) => call.copy.byteLength),
    problems: provider.handed.map((call) => call.problems),
    distinctBuffers: new Set(provider.handed.map((call) => call.buffer)).size,
  }).toEqual({
    calls: 3,
    lengths: [KEY_BYTES, KEY_BYTES, KEY_BYTES],
    problems: [[], [], []],
    distinctBuffers: 3,
  });
});

it('[AC-B1-01zn#2][BR-ID-33] LocalKeyProvider.unwrapKey 返回的密钥独占内存：1、16、32、64、4095、4096、8192、9000 字节的密钥解包后 byteOffset 为 0、buffer.byteLength 正好等于密钥长度、不是共享 Buffer 池，字节就是被包裹的那把密钥，池里找不到它们（16 字节及以上）和主密钥', async () => {
  probePool();
  const master = testKey(MASTER_LABEL);
  const provider = new LocalKeyProvider(master, 'pool-b');
  probePool();
  const problems: Record<string, string[]> = {};
  const keys: Record<string, Uint8Array> = { master: copyOf(master) };
  for (const size of [1, 16, 32, 64, 4095, 4096, 8192, 9000]) {
    const key = randomBytes(size);
    const reference = copyOf(key);
    probePool();
    const wrapped = await provider.wrapKey(key);
    probePool();
    const unwrapped = await provider.unwrapKey(wrapped);
    probePool();
    problems[String(size)] = [
      ...ownershipProblems(unwrapped),
      ...(Buffer.from(unwrapped.buffer, unwrapped.byteOffset, unwrapped.byteLength).equals(
        Buffer.from(reference.buffer),
      )
        ? []
        : ['bytes differ from the wrapped key']),
    ];
    // A 1-byte value is found in any pool by chance; only keys of 16 bytes and more are searched.
    if (size >= 16) keys[`key-${String(size)}`] = reference;
  }
  expect({ problems, inPools: keysInPools(keys) }).toEqual({
    problems: Object.fromEntries(
      [1, 16, 32, 64, 4095, 4096, 8192, 9000].map((size) => [String(size), []]),
    ),
    inPools: [],
  });
});

it('[AC-B1-01zn#3][BR-ID-33] 构造 LocalKeyProvider、新建与两次轮换 keyring、打开它（provider 原样返回解包密钥，或返回大 ArrayBuffer 中间的视图）、加密、解密、重加密、盲索引之后，期间用过的每一个共享 Buffer 池里都找不到主密钥、任何一版数据密钥或盲索引密钥的字节', async () => {
  const master = testKey(MASTER_LABEL);
  const keys: Record<string, Uint8Array> = { master: copyOf(master) };
  probePool();
  const local = new LocalKeyProvider(master, 'pool-c');
  probePool();
  const recorder = new RecordingProvider(local);
  let doc = await createWrappedKeyring(recorder);
  probePool();
  doc = await rotateDataKey(doc, recorder);
  probePool();
  doc = await rotateDataKey(doc, recorder);
  probePool();
  // Wrap order: data key v1, blind-index key, data key v2, data key v3.
  const names = ['dataKeyV1', 'blindIndexKey', 'dataKeyV2', 'dataKeyV3'];
  recorder.handed.forEach((call, i) => {
    keys[names[i] ?? `extra-${String(i)}`] = call.copy;
  });
  const outcomes: Record<string, unknown> = {};
  for (const [label, provider] of [
    ['as-returned', new RecordingProvider(local)],
    ['view', new RecordingProvider(local, 24)],
  ] as const) {
    probePool();
    const crypto = await openFieldCrypto(doc, provider);
    probePool();
    provider.returned.forEach((key, i) => {
      keys[`${label}-unwrapped-${String(i)}`] = key;
    });
    const context = 'users.phone';
    const ciphertext = crypto.encrypt(SAMPLES.phone, context);
    probePool();
    const plaintext = crypto.decrypt(ciphertext, context);
    probePool();
    const reencrypted = crypto.reencrypt(ciphertext, context);
    probePool();
    const index = crypto.blindIndex(SAMPLES.phone, context);
    probePool();
    outcomes[label] = {
      unwrapCalls: provider.returned.length,
      plaintext,
      reencryptedPlaintext: crypto.decrypt(reencrypted, context),
      version: crypto.keyVersionOf(ciphertext),
      indexShape: /^[0-9a-f]{64}$/.test(index),
    };
    probePool();
  }
  const expected = {
    unwrapCalls: 4,
    plaintext: SAMPLES.phone,
    reencryptedPlaintext: SAMPLES.phone,
    version: 3,
    indexShape: true,
  };
  expect({
    wrapCalls: recorder.handed.length,
    outcomes,
    poolsSeen: pools.size > 0,
    inPools: keysInPools(keys),
  }).toEqual({
    wrapCalls: 4,
    outcomes: { 'as-returned': expected, view: expected },
    poolsSeen: true,
    inPools: [],
  });
});

it('[AC-B1-01zn#4][BR-ID-33] 对照：本文件的池探测确实能发现落进共享 Buffer 池的密钥——测试自己用 Buffer.from 复制一把对照密钥（不是模块用的任何一把）后，探测到的池里能找到它', () => {
  const control = testKey(CONTROL_LABEL);
  const reference = copyOf(control);
  probePool();
  const before = keysInPools({ control: reference });
  const pooled = Buffer.from(reference);
  probePool();
  expect({
    before,
    pooledIsView: pooled.buffer.byteLength > pooled.byteLength,
    after: keysInPools({ control: reference }),
  }).toEqual({ before: [], pooledIsView: true, after: ['control'] });
});
