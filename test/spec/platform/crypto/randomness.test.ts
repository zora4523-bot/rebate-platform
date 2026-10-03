// Rule tests for 规划/08 BR-ID-33 (AES-256-GCM 字段级加密、KMS 信封加密、支持轮换) on where the
// module's randomness comes from. AES-GCM breaks when an IV repeats under one key, and a key that
// is not random is no key; a counter, a fixed IV with a random suffix, an IV or key derived from
// the clock all produce texts that merely look different. The contract therefore says: every IV
// is its own randomBytes(12) and every new key its own randomBytes(32), used as returned, and
// nothing else calls randomBytes. In a new process (child.ts, mode `random`) randomBytes is
// replaced by a recorder before the module is loaded; these tests compare every IV and every key
// with the recorded calls and count the calls of each operation.
// The last test reads the module's sources: they import node:crypto and their own files only, so
// nothing can be written to a log, a file or the network (日志中不得出现明文).
// Top-level it() only (规划/11 §4.3).
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ChildReply, ChildRequest, RecordedStep } from './child.ts';
import {
  FakeKms,
  IV_BYTES,
  KEY_BYTES,
  TAG_BYTES,
  fakeUnwrap,
  ivOfLk1,
  knownKeyring,
  parseLk1,
  parseV1,
  referenceDecrypt,
  referenceUnwrap,
  testBytes,
  testKey,
} from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
const MODULE_DIR = fileURLToPath(
  new URL('../../../../apps/api/src/modules/platform/crypto/', import.meta.url),
);

const MASTER = 240;
const KEY_ID = 'local-dev';
const KMS_KEY_ID = 'fake-kms/master-a';
const VALUES = [
  { text: '13877776666', context: 'users.phone' },
  { text: '11010519491231002X', context: 'realname.id_no' },
  { text: `<${'测'.repeat(300)}>`, context: 'payout_accounts.payee_name' },
];
const WRAP_KEYS = [testKey(1), testBytes(7, 16), testBytes(8, 64)];

type Keyring = { data_keys: { version: number; wrapped: string }[]; blind_index_key: string };

/** One run of child.ts in mode `random`; its steps, or a failed step carrying the error. */
function recordedSteps(): RecordedStep[] {
  const kms = new FakeKms(KMS_KEY_ID);
  const request: ChildRequest = {
    mode: 'random',
    seed: 'b1-01a-randomness',
    masterKeyHex: testKey(MASTER).toString('hex'),
    keyId: KEY_ID,
    kmsKeyring: JSON.stringify(knownKeyring(kms, [1], 1).doc),
    kmsKeyId: KMS_KEY_ID,
    values: VALUES,
    wrapHex: WRAP_KEYS.map((key) => key.toString('hex')),
  };
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
  });
  let reply: ChildReply;
  try {
    reply = JSON.parse(run.stdout) as ChildReply;
  } catch {
    reply = { error: `exit ${String(run.status)}: ${run.stderr.slice(-300)}` };
  }
  if ('steps' in reply) return reply.steps;
  return [{ op: 'failed', calls: [], result: JSON.stringify(reply) }];
}

function stepsOf(steps: readonly RecordedStep[], op: string): RecordedStep[] {
  return steps.filter((step) => step.op === op);
}

function sizes(step: RecordedStep | undefined): number[] {
  return (step?.calls ?? []).map((call) => call.size).sort((a, b) => a - b);
}

/** The returned bytes of the calls of one size, in call order. */
function outputs(step: RecordedStep | undefined, size: number): string[] {
  return (step?.calls ?? []).filter((call) => call.size === size).map((call) => call.hex);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** The value, or the text of the error: a reference check that throws becomes a visible diff. */
function attempt<T>(run: () => T): T | string {
  try {
    return run();
  } catch (error) {
    return `failed: ${String(error)}`;
  }
}

function ivOfV1(ciphertext: string): string {
  return parseV1(ciphertext).payload.subarray(0, IV_BYTES).toString('hex');
}

it('[BR-ID-33] 字段加密的 IV 就是那一次 randomBytes(12) 的结果：新进程里把 randomBytes 换成记录器，每次 encrypt 正好调用一次 randomBytes(12)、密文里的 IV 与它返回的字节相同，node:crypto 用数据密钥独立解得开；打开 keyring、解密、建索引、读版本不调用 randomBytes', () => {
  const steps = recordedSteps();
  const key = knownKeyring(new FakeKms(KMS_KEY_ID), [1], 1).dataKey(1);
  const encrypts = stepsOf(steps, 'encrypt');
  expect({
    open: stepsOf(steps, 'open').map(sizes),
    encrypt: encrypts.map((step) => ({
      sizes: sizes(step),
      ivIsTheRandomBytes: attempt(() => ivOfV1(step.result)) === outputs(step, IV_BYTES)[0],
    })),
    decryptedWithTheDataKey: encrypts.map((step, i) =>
      attempt(() => referenceDecrypt(key, step.result, VALUES[i]?.context ?? '')),
    ),
    noRandomness: ['decrypt', 'blindIndex', 'keyVersionOf', 'needsReencrypt'].map((op) =>
      stepsOf(steps, op).map(sizes),
    ),
  }).toEqual({
    open: [[]],
    encrypt: VALUES.map(() => ({ sizes: [IV_BYTES], ivIsTheRandomBytes: true })),
    decryptedWithTheDataKey: VALUES.map((v) => v.text),
    noRandomness: ['decrypt', 'blindIndex', 'keyVersionOf', 'needsReencrypt'].map(() =>
      VALUES.map(() => []),
    ),
  });
});

it('[BR-ID-33] 新生成的数据密钥与盲索引密钥就是 randomBytes(32) 的结果：新建 keyring 正好调用两次 randomBytes(32)、交给 KMS 包裹的正是这两份字节（一把数据密钥、一把盲索引密钥）；轮换正好调用一次 randomBytes(32)，新版本的密钥就是它，旧条目不变', () => {
  const steps = recordedSteps();
  const [create] = stepsOf(steps, 'kmsCreate');
  const [rotate] = stepsOf(steps, 'kmsRotate');
  const [plain] = stepsOf(steps, 'kmsPlainKeys');
  const created = JSON.parse(create?.result ?? '{}') as Keyring;
  const rotated = JSON.parse(rotate?.result ?? '{}') as Keyring;
  const plainKeys = JSON.parse(plain?.result ?? '[]') as string[];
  const unwrap = (text: string | undefined): string =>
    attempt(() => fakeUnwrap(text ?? '', KMS_KEY_ID).toString('hex'));
  const createdKeys = [unwrap(created.data_keys?.[0]?.wrapped), unwrap(created.blind_index_key)];
  expect({
    createSizes: sizes(create),
    wrappedByKms: sorted(plainKeys.slice(0, 2)),
    storedKeys: sorted(createdKeys),
    dataKeyIsNotTheBlindKey: createdKeys[0] !== createdKeys[1],
    rotateSizes: sizes(rotate),
    rotatedWrappedByKms: plainKeys.slice(2),
    newVersionKey: unwrap(rotated.data_keys?.find((e) => e.version === 2)?.wrapped),
    keptEntries: rotated.data_keys?.filter((e) => e.version === 1),
    keptBlindKey: rotated.blind_index_key,
  }).toEqual({
    createSizes: [KEY_BYTES, KEY_BYTES],
    wrappedByKms: sorted(outputs(create, KEY_BYTES)),
    storedKeys: sorted(outputs(create, KEY_BYTES)),
    dataKeyIsNotTheBlindKey: true,
    rotateSizes: [KEY_BYTES],
    rotatedWrappedByKms: outputs(rotate, KEY_BYTES),
    newVersionKey: outputs(rotate, KEY_BYTES)[0],
    keptEntries: created.data_keys,
    keptBlindKey: created.blind_index_key,
  });
});

it('[BR-ID-33] LocalKeyProvider 包裹密钥的 IV 就是那一次 randomBytes(12) 的结果：每次 wrapKey 正好调用一次，lk1 文本里的 IV 与返回的字节相同，按格式用主密钥独立解开正好是那把密钥（不多不少）；新建 keyring 调用两次 randomBytes(32) 与两次 randomBytes(12)、轮换各一次，存下的密钥与 IV 正是这些字节；构造与解包不调用 randomBytes', () => {
  const steps = recordedSteps();
  const master = testKey(MASTER);
  const wraps = stepsOf(steps, 'wrapKey');
  const [create] = stepsOf(steps, 'localCreate');
  const [rotate] = stepsOf(steps, 'localRotate');
  const created = JSON.parse(create?.result ?? '{}') as Keyring;
  const rotated = JSON.parse(rotate?.result ?? '{}') as Keyring;
  const createdTexts = [created.data_keys?.[0]?.wrapped ?? '', created.blind_index_key ?? ''];
  const newEntry = rotated.data_keys?.find((e) => e.version === 2)?.wrapped ?? '';
  const iv = (text: string): string => attempt(() => ivOfLk1(text).toString('hex'));
  const unwrap = (text: string): string =>
    attempt(() => referenceUnwrap(master, KEY_ID, text).toString('hex'));
  expect({
    construct: stepsOf(steps, 'construct').map(sizes),
    wrapKey: wraps.map((step) => ({
      sizes: sizes(step),
      ivIsTheRandomBytes: iv(step.result) === outputs(step, IV_BYTES)[0],
      payloadBytes: attempt(() => parseLk1(step.result).length),
      unwrapped: unwrap(step.result),
    })),
    unwrapKey: stepsOf(steps, 'unwrapKey').map((step) => ({
      sizes: sizes(step),
      key: step.result,
    })),
    createSizes: sizes(create),
    createdIvs: sorted(createdTexts.map(iv)),
    createdKeys: sorted(createdTexts.map(unwrap)),
    rotateSizes: sizes(rotate),
    rotatedIv: iv(newEntry),
    rotatedKey: unwrap(newEntry),
    keptEntries: rotated.data_keys?.filter((e) => e.version === 1),
    keptBlindKey: rotated.blind_index_key,
  }).toEqual({
    construct: [[]],
    wrapKey: WRAP_KEYS.map((key) => ({
      sizes: [IV_BYTES],
      ivIsTheRandomBytes: true,
      payloadBytes: IV_BYTES + key.length + TAG_BYTES,
      unwrapped: key.toString('hex'),
    })),
    unwrapKey: WRAP_KEYS.map((key) => ({ sizes: [], key: key.toString('hex') })),
    createSizes: [IV_BYTES, IV_BYTES, KEY_BYTES, KEY_BYTES],
    createdIvs: sorted(outputs(create, IV_BYTES)),
    createdKeys: sorted(outputs(create, KEY_BYTES)),
    rotateSizes: [IV_BYTES, KEY_BYTES],
    rotatedIv: outputs(rotate, IV_BYTES)[0],
    rotatedKey: outputs(rotate, KEY_BYTES)[0],
    keptEntries: created.data_keys,
    keptBlindKey: created.blind_index_key,
  });
});

it('[BR-ID-33] 重新加密也用新的 randomBytes(12) 作 IV：轮换后 reencrypt 正好调用一次，新密文的 IV 是它返回的字节、带新版本，用新版本的数据密钥独立解开得到原文；打开 keyring 不调用 randomBytes', () => {
  const steps = recordedSteps();
  const master = testKey(MASTER);
  const [rotate] = stepsOf(steps, 'localRotate');
  const [reencrypt] = stepsOf(steps, 'reencrypt');
  const rotated = JSON.parse(rotate?.result ?? '{}') as Keyring;
  const result = reencrypt?.result ?? '';
  const first = VALUES[0] ?? { text: '', context: '' };
  expect({
    open: stepsOf(steps, 'localOpen').map(sizes),
    sizes: sizes(reencrypt),
    version: attempt(() => parseV1(result).version),
    ivIsTheRandomBytes: attempt(() => ivOfV1(result)) === outputs(reencrypt, IV_BYTES)[0],
    decrypted: attempt(() => {
      const wrapped = rotated.data_keys?.find((e) => e.version === 2)?.wrapped ?? '';
      return referenceDecrypt(referenceUnwrap(master, KEY_ID, wrapped), result, first.context);
    }),
  }).toEqual({
    open: [[]],
    sizes: [IV_BYTES],
    version: 2,
    ivIsTheRandomBytes: true,
    decrypted: first.text,
  });
});

it('[BR-ID-33] 模块不往日志、文件或网络写东西：crypto 目录里的源码（单元测试以外）用 node:crypto 加密，除它与本目录的文件外什么都不导入', () => {
  const sources = readdirSync(MODULE_DIR).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const specifier =
    /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  const imports = new Set<string>();
  for (const name of sources) {
    const text = readFileSync(`${MODULE_DIR}${name}`, 'utf8');
    for (const match of text.matchAll(specifier)) {
      imports.add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  const outside = [...imports].filter((s) => s !== 'node:crypto' && !/^\.\/[^/]+\.ts$/.test(s));
  expect({
    hasIndex: sources.includes('index.ts'),
    usesNodeCrypto: imports.has('node:crypto'),
    outside,
  }).toEqual({
    hasIndex: true,
    usesNodeCrypto: true,
    outside: [],
  });
});
