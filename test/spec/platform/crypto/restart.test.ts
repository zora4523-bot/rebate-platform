// Rule tests for 规划/08 BR-ID-33 across a process restart: AES-256-GCM needs an IV that never
// repeats under one data key, and KMS 信封加密 means that what was stored (the wrapped keyring,
// the ciphertexts) is all a new process needs, together with the master key. Within one process
// a module-level counter or an in-memory table of wrapped keys passes every other test, so the
// second half of each scenario runs in a new `node` process (child.ts) that only receives text.
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
  SAMPLES,
  knownKeyring,
  parseV1,
  referenceBlindIndex,
  referenceDecrypt,
  testKey,
} from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));

/** Runs child.ts in a new node process; a crash is turned into an error reply. */
function inNewProcess(request: ChildRequest): ChildReply {
  const run = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0) {
    const detail = `${run.error?.message ?? ''} ${run.stderr.slice(-400)}`.trim();
    return { error: `child exited with ${String(run.status ?? run.signal)}: ${detail}` };
  }
  return JSON.parse(run.stdout) as ChildReply;
}

function ciphertextsOf(reply: ChildReply): string[] {
  if ('ciphertexts' in reply) return reply.ciphertexts;
  throw new Error(`child process failed: ${JSON.stringify(reply)}`);
}

const PHONE_CONTEXT = 'users.phone';
const ID_CONTEXT = 'realname.id_no';
const MASTER = 240;

it('[BR-ID-33] 换一个进程 IV 也不重复：两个新进程只拿到同一份存下来的 keyring，与本进程各加密 50 次，150 个 IV 两两不同、96 位里每一位都出现过 0 和 1，每份密文都用 keyring 里的数据密钥解得开', async () => {
  const kms = new FakeKms();
  const known = knownKeyring(kms, [1], 1);
  const stored = JSON.stringify(known.doc);
  const values = Array.from({ length: 50 }, (_, i) => ({
    text: i % 2 === 0 ? SAMPLES.phone : `139${String(20000000 + i)}`,
    context: PHONE_CONTEXT,
  }));
  const here = await openFieldCrypto(JSON.parse(stored) as WrappedKeyring, new FakeKms());
  const runs = {
    // One after the other, like a restart: the second process starts after the first has ended.
    firstProcess: inNewProcess({ mode: 'encrypt', keyring: stored, kmsKeyId: kms.keyId, values }),
    secondProcess: inNewProcess({ mode: 'encrypt', keyring: stored, kmsKeyId: kms.keyId, values }),
  };
  const ciphertexts = [
    ...values.map((v) => here.encrypt(v.text, v.context)),
    ...ciphertextsOf(runs.firstProcess),
    ...ciphertextsOf(runs.secondProcess),
  ];
  const ivs = ciphertexts.map((c) => Buffer.from(parseV1(c).payload.subarray(0, IV_BYTES)));
  const stuckBits: number[] = [];
  for (let bit = 0; bit < IV_BYTES * 8; bit += 1) {
    const ones = ivs.filter((iv) => ((iv[bit >> 3] ?? 0) >> (bit & 7)) % 2 === 1).length;
    if (ones === 0 || ones === ivs.length) stuckBits.push(bit);
  }
  const expectedTexts = [...values, ...values, ...values].map((v) => v.text);
  expect({
    total: ivs.length,
    distinct: new Set(ivs.map((iv) => iv.toString('hex'))).size,
    stuckBits,
    decryptedWithStoredKey: ciphertexts.map((c) =>
      referenceDecrypt(known.dataKey(1), c, PHONE_CONTEXT),
    ),
  }).toEqual({ total: 150, distinct: 150, stuckBits: [], decryptedWithStoredKey: expectedTexts });
});

it('[BR-ID-33] 进程重启后照常可用（新进程验证）：新进程只凭主密钥字节、keyId、存下来的 keyring 与密文，解开重启前两个版本的密文、算出相同的盲索引、解开包裹过的密钥；新进程用同一把主密钥建的 keyring 与密文，本进程也打得开', async () => {
  const masterKey = testKey(MASTER);
  const before = new LocalKeyProvider(masterKey, 'local-dev');
  const created = await createWrappedKeyring(before);
  const version1 = (await openFieldCrypto(created, before)).encrypt(SAMPLES.idNo, ID_CONTEXT);
  const rotated = await rotateDataKey(created, before);
  const second = await openFieldCrypto(rotated, before);
  const version2 = second.encrypt(SAMPLES.idNo, ID_CONTEXT);
  const index = second.blindIndex(SAMPLES.idNo, ID_CONTEXT);
  const looseWrapped = await before.wrapKey(testKey(1));
  const blindKey = await before.unwrapKey(rotated.blind_index_key);

  // Restart: a new process gets the master key bytes, the key id and stored text, nothing else.
  const recovered = inNewProcess({
    mode: 'recover',
    masterKeyHex: masterKey.toString('hex'),
    keyId: 'local-dev',
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
    keyId: 'local-dev',
    encrypt: [{ text: SAMPLES.phone, context: PHONE_CONTEXT }],
    wrapHex: [testKey(2).toString('hex')],
  });
  let openedHere: Record<string, unknown> = { error: JSON.stringify(produced) };
  if ('keyring' in produced) {
    const provider = new LocalKeyProvider(Buffer.from(masterKey), 'local-dev');
    const crypto = await openFieldCrypto(JSON.parse(produced.keyring) as WrappedKeyring, provider);
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
});
