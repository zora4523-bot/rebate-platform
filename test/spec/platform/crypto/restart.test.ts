// Rule tests for 规划/08 BR-ID-33 across process restarts: AES-256-GCM needs an IV that never
// repeats under one key (the data keys, and the master key that wraps them), new keys must be new
// random keys, and KMS 信封加密 means that what was stored (the wrapped keyring, the ciphertexts)
// is all a new process needs, together with the master key. Within one process a module-level
// counter or an in-memory table of wrapped keys passes every other test, so the second half of
// each scenario runs in a new `node` process (child.ts) that only receives text.
// The same processes show what the module prints (日志中不得出现明文): a process that runs every
// operation, successful and refused, writes exactly its own JSON reply and nothing else.
// Top-level it() only (规划/11 §4.3).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  LocalKeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { ChildReply, ChildRequest } from './child.ts';
import {
  FakeKms,
  IV_BYTES,
  KEY_BYTES,
  SAMPLES,
  ivOfLk1,
  knownKeyring,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  referenceUnwrap,
  stuckBits,
  testKey,
} from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

interface ChildRun {
  /** The JSON reply; a crash, or stdout that is not one JSON value, is an error reply. */
  readonly reply: ChildReply;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs child.ts in a new node process and keeps everything it printed. */
function runChild(request: ChildRequest): ChildRun {
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const common = { status: run.status, stdout: run.stdout, stderr: run.stderr };
  if (run.status !== 0) {
    const detail = `${run.error?.message ?? ''} ${run.stderr.slice(-400)}`.trim();
    return { ...common, reply: { error: `child exited with ${String(run.status)}: ${detail}` } };
  }
  try {
    return { ...common, reply: JSON.parse(run.stdout) as ChildReply };
  } catch {
    return {
      ...common,
      reply: { error: `stdout is not one JSON reply: ${run.stdout.slice(0, 200)}` },
    };
  }
}

function inNewProcess(request: ChildRequest): ChildReply {
  return runChild(request).reply;
}

function ciphertextsOf(reply: ChildReply): string[] {
  if ('ciphertexts' in reply) return reply.ciphertexts;
  throw new Error(`child process failed: ${JSON.stringify(reply)}`);
}

function producedOf(reply: ChildReply): { keyrings: string[]; wrapped: string[] } {
  if ('keyrings' in reply) return reply;
  throw new Error(`child process failed: ${JSON.stringify(reply)}`);
}

const PHONE_CONTEXT = 'users.phone';
const ID_CONTEXT = 'realname.id_no';
const MASTER = 240;
const KEY_ID = 'local-dev';

it('[BR-ID-33] 换一个进程字段加密的 IV 也不重复：两个新进程只拿到同一份存下来的 keyring，与本进程各加密 50 次，150 个 IV 两两不同、96 位里每一位都出现过 0 和 1，每份密文都用 keyring 里的数据密钥解得开', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1], 1);
  const stored = JSON.stringify(known.doc);
  const values = Array.from({ length: 50 }, (_, i) => ({
    text: i % 2 === 0 ? SAMPLES.phone : `139${String(20000000 + i)}`,
    context: PHONE_CONTEXT,
  }));
  const here = await openFieldCrypto(JSON.parse(stored) as WrappedKeyring, new FakeKms());
  // One after the other, like a restart: the second process starts after the first has ended.
  const first = inNewProcess({ mode: 'encrypt', keyring: stored, kmsKeyId: kms.keyId, values });
  const second = inNewProcess({ mode: 'encrypt', keyring: stored, kmsKeyId: kms.keyId, values });
  const ciphertexts = [
    ...values.map((v) => here.encrypt(v.text, v.context)),
    ...ciphertextsOf(first),
    ...ciphertextsOf(second),
  ];
  const ivs = ciphertexts.map((c) => Buffer.from(parseV1(c).payload.subarray(0, IV_BYTES)));
  expect({
    total: ivs.length,
    distinct: new Set(ivs.map((iv) => iv.toString('hex'))).size,
    stuckBits: stuckBits(ivs, IV_BYTES * 8),
    decryptedWithStoredKey: ciphertexts.map((c) =>
      referenceDecrypt(known.dataKey(1), c, PHONE_CONTEXT),
    ),
  }).toEqual({
    total: 150,
    distinct: 150,
    stuckBits: [],
    decryptedWithStoredKey: [...values, ...values, ...values].map((v) => v.text),
  });
}, 30_000);

it('[BR-ID-33] 进程重启后照常可用（新进程验证）：新进程只凭主密钥字节、keyId、存下来的 keyring 与密文，解开重启前两个版本的密文、算出相同的盲索引、解开包裹过的密钥；新进程用同一把主密钥建的 keyring 与密文，本进程也打得开', async () => {
  const masterKey = testKey(MASTER);
  const before = new LocalKeyProvider(masterKey, KEY_ID);
  const created = await createWrappedKeyring(before);
  const version1 = (await openFieldCrypto(created, before)).encrypt(SAMPLES.idNo, ID_CONTEXT);
  const rotated = await rotateDataKey(created, before);
  const second = await openFieldCrypto(rotated, before);
  const version2 = second.encrypt(SAMPLES.idNo, ID_CONTEXT);
  const index = second.blindIndex(SAMPLES.idNo, ID_CONTEXT);
  const looseWrapped = await before.wrapKey(testKey(1));
  const blindKey = referenceUnwrap(masterKey, KEY_ID, rotated.blind_index_key);

  // Restart: a new process gets the master key bytes, the key id and stored text, nothing else.
  const recovered = inNewProcess({
    mode: 'recover',
    masterKeyHex: masterKey.toString('hex'),
    keyId: KEY_ID,
    keyring: JSON.stringify(rotated),
    decrypt: [
      { ciphertext: version1, context: ID_CONTEXT },
      { ciphertext: version2, context: ID_CONTEXT },
    ],
    index: [{ text: SAMPLES.idNo, context: ID_CONTEXT }],
    unwrap: [looseWrapped],
  });

  // And the other way round: what a new process stored, this process opens with a provider
  // built from the same master key bytes.
  const produced = inNewProcess({
    mode: 'produce',
    masterKeyHex: masterKey.toString('hex'),
    keyId: KEY_ID,
    keyrings: 1,
    encrypt: [{ text: SAMPLES.phone, context: PHONE_CONTEXT }],
    wrapHex: [testKey(2).toString('hex')],
  });
  let openedHere: Record<string, unknown> = { error: JSON.stringify(produced) };
  if ('keyrings' in produced) {
    const provider = new LocalKeyProvider(Buffer.from(masterKey), KEY_ID);
    const keyring = JSON.parse(produced.keyrings[0] ?? '{}') as WrappedKeyring;
    const crypto = await openFieldCrypto(keyring, provider);
    openedHere = {
      decrypted: produced.ciphertexts.map((c) => crypto.decrypt(c, PHONE_CONTEXT)),
      unwrapped: await Promise.all(
        produced.wrapped.map(async (w) => Buffer.from(await provider.unwrapKey(w)).toString('hex')),
      ),
    };
  }

  const expectedIndex = referenceBlindIndex(blindKey, SAMPLES.idNo, ID_CONTEXT);
  expect({ indexBeforeRestart: index, recovered, openedHere }).toEqual({
    indexBeforeRestart: expectedIndex,
    recovered: {
      versions: [1, 2],
      decrypted: [SAMPLES.idNo, SAMPLES.idNo],
      indexes: [expectedIndex],
      unwrappedHex: [testKey(1).toString('hex')],
    },
    openedHere: { decrypted: [SAMPLES.phone], unwrapped: [testKey(2).toString('hex')] },
  });
}, 30_000);

it('[BR-ID-33] 换一个进程包裹密钥的 IV 也不重复：本进程与两个新进程用同一把主密钥各把同一把密钥包裹 10 次，30 份 lk1 包裹文本的 IV 两两不同、96 位里每一位都出现过 0 和 1，每份都按 lk1 格式用主密钥独立解开、正好是那把密钥', async () => {
  const masterKey = testKey(MASTER);
  const here = new LocalKeyProvider(masterKey, KEY_ID);
  const key = testKey(1);
  const request: ChildRequest = {
    mode: 'produce',
    masterKeyHex: masterKey.toString('hex'),
    keyId: KEY_ID,
    keyrings: 0,
    encrypt: [],
    wrapHex: Array.from({ length: 10 }, () => key.toString('hex')),
  };
  const wrapped: string[] = [];
  for (let i = 0; i < 10; i += 1) wrapped.push(await here.wrapKey(key));
  // One after the other, like a restart.
  wrapped.push(...producedOf(inNewProcess(request)).wrapped);
  wrapped.push(...producedOf(inNewProcess(request)).wrapped);
  const ivs = wrapped.map((text) => ivOfLk1(text));
  expect({
    total: wrapped.length,
    distinctIvs: new Set(ivs.map((iv) => iv.toString('hex'))).size,
    stuckBits: stuckBits(ivs, IV_BYTES * 8),
    unwrapped: wrapped.map((text) => referenceUnwrap(masterKey, KEY_ID, text).toString('hex')),
  }).toEqual({
    total: 30,
    distinctIvs: 30,
    stuckBits: [],
    unwrapped: wrapped.map(() => key.toString('hex')),
  });
}, 30_000);

it('[BR-ID-33] 换一个进程新生成的密钥也是新的随机密钥：本进程与两个新进程各新建 5 份 keyring 并各轮换一次，45 把数据密钥与盲索引密钥（按 lk1 格式用主密钥独立解包）都是 32 字节、两两不同、256 位里每一位都出现过 0 和 1，它们的 45 个包裹 IV 也两两不同', async () => {
  const masterKey = testKey(MASTER);
  const here = new LocalKeyProvider(masterKey, KEY_ID);
  const keyrings: WrappedKeyring[] = [];
  for (let i = 0; i < 5; i += 1) {
    keyrings.push(await rotateDataKey(await createWrappedKeyring(here), here));
  }
  const request: ChildRequest = {
    mode: 'produce',
    masterKeyHex: masterKey.toString('hex'),
    keyId: KEY_ID,
    keyrings: 5,
    encrypt: [],
    wrapHex: [],
  };
  for (const reply of [inNewProcess(request), inNewProcess(request)]) {
    keyrings.push(...producedOf(reply).keyrings.map((text) => JSON.parse(text) as WrappedKeyring));
  }
  const wrappedTexts = keyrings.flatMap((doc) => [
    ...doc.data_keys.map((entry) => entry.wrapped),
    doc.blind_index_key,
  ]);
  const keys = wrappedTexts.map((text) => referenceUnwrap(masterKey, KEY_ID, text));
  expect({
    keyrings: keyrings.length,
    versions: keyrings.map((doc) => doc.data_keys.map((entry) => entry.version)),
    keys: keys.length,
    lengths: [...new Set(keys.map((key) => key.length))],
    distinctKeys: new Set(keys.map((key) => key.toString('hex'))).size,
    stuckBits: stuckBits(keys, KEY_BYTES * 8),
    distinctIvs: new Set(wrappedTexts.map((text) => ivOfLk1(text).toString('hex'))).size,
  }).toEqual({
    keyrings: 15,
    versions: keyrings.map(() => [1, 2]),
    keys: 45,
    lengths: [KEY_BYTES],
    distinctKeys: 45,
    stuckBits: [],
    distinctIvs: 45,
  });
}, 30_000);

it('[BR-ID-33] 不往标准输出与标准错误里打印：新进程里新建、轮换、打开 keyring，加密、解密、重新加密、建索引、读版本，包裹与解包，以及每一种错误码的被拒调用（含 provider 失败：新建、轮换、打开 keyring 时 provider 第几次调用抛出或拒绝 × 普通 Error 或同码的 FieldCryptoError，共 24 种）之后，标准错误一个字节也没有，标准输出正好是进程自己的那一份 JSON 回复', () => {
  const values = [
    { text: '13877776666', context: PHONE_CONTEXT },
    { text: '11010519491231002X', context: ID_CONTEXT },
    { text: 'payee-rule-test@example.com', context: 'payout_accounts.alipay_logon_id' },
    { text: '6200000000000077777', context: 'payout_accounts.bank_card_no' },
    { text: SAMPLES.name, context: 'realname.name' },
    { text: SAMPLES.astral, context: 'payout_accounts.payee_name' },
  ];
  const run = runChild({
    mode: 'exercise',
    masterKeyHex: testKey(MASTER).toString('hex'),
    keyId: KEY_ID,
    values,
    wrapHex: testKey(3).toString('hex'),
  });
  // Provider failures (child.ts): creating wraps 2 keys, rotating wraps 1, opening unwraps 3;
  // each call × thrown or rejected × plain Error or FieldCryptoError = 6 × 2 × 2 refused calls.
  const providerFailures = Array.from({ length: 24 }, () => 'key_provider_failed');
  const perValue = [
    'decrypt_failed',
    'unknown_key_version',
    'malformed_ciphertext',
    'invalid_context',
    'invalid_plaintext',
    'malformed_ciphertext',
    'malformed_ciphertext',
    'malformed_ciphertext',
    'invalid_context',
  ];
  expect({
    status: run.status,
    stderr: run.stderr,
    stdoutIsExactlyTheReply: run.stdout === JSON.stringify(run.reply),
    reply: run.reply,
  }).toEqual({
    status: 0,
    stderr: '',
    stdoutIsExactlyTheReply: true,
    reply: {
      outcomes: [
        ...values.flatMap(() => perValue),
        'decrypt_failed',
        'invalid_keyring',
        'invalid_key',
        'key_provider_failed',
        'invalid_keyring',
        'invalid_key',
        ...providerFailures,
      ],
    },
  });
}, 30_000);
