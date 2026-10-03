// Child process of the restart and randomness rule tests (规划/08 BR-ID-33). It is started with
// plain `node <this file>`: a new process that imports the module under test anew, so nothing
// the parent holds in memory (a module-level IV counter, a table of wrapped keys) exists here.
// Only text crosses the process boundary: one JSON request on stdin (a serialised keyring,
// ciphertexts, a key id, key bytes in hex), one JSON reply on stdout, nothing on stderr.
// In mode `random` the process first replaces `randomBytes` of node:crypto with a recorder that
// returns known bytes, and only then imports the module under test (dynamic import below, so the
// replacement is in place before the module is evaluated); the reply says which calls every
// operation made.
// Any failure is replied as { "error": "<FieldCryptoError code or message>" }, so that the
// parent's single assertion shows it. Import only the types of this file (`import type`):
// importing it for real would run it and wait for stdin.
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

type CryptoModule = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
type KitModule = typeof import('./kit.ts');

const MODULE_UNDER_TEST = '../../../../apps/api/src/modules/platform/crypto/index.ts';

/** A value to encrypt or to index, with its context. */
export interface FieldValue {
  readonly text: string;
  readonly context: string;
}

/** A ciphertext with the context it was encrypted under. */
export interface StoredCiphertext {
  readonly ciphertext: string;
  readonly context: string;
}

/** One call of randomBytes while the recorder was in place. */
export interface RandomCall {
  readonly size: number;
  readonly hex: string;
}

/** One operation of mode `random`, the randomBytes calls it made and what it returned. */
export interface RecordedStep {
  readonly op: string;
  readonly calls: RandomCall[];
  readonly result: string;
}

export type ChildRequest =
  /** Opens the keyring with an in-test KMS stand-in (FakeKms) and encrypts the values. */
  | {
      readonly mode: 'encrypt';
      readonly keyring: string;
      readonly kmsKeyId: string;
      readonly values: readonly FieldValue[];
    }
  /** Rebuilds a LocalKeyProvider from the master-key bytes and reads what was stored before. */
  | {
      readonly mode: 'recover';
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly keyring: string;
      readonly decrypt: readonly StoredCiphertext[];
      readonly index: readonly FieldValue[];
      readonly unwrap: readonly string[];
    }
  /**
   * With a LocalKeyProvider from the master-key bytes: `keyrings` new keyrings, each rotated
   * once, ciphertexts of `encrypt` under the first of them, and `wrapHex` wrapped.
   */
  | {
      readonly mode: 'produce';
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly keyrings: number;
      readonly encrypt: readonly FieldValue[];
      readonly wrapHex: readonly string[];
    }
  /**
   * Runs every operation of the module, successful and refused ones (every error code), and
   * replies only with the outcomes of the refused calls: the parent checks that the process
   * printed nothing else.
   */
  | {
      readonly mode: 'exercise';
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly values: readonly FieldValue[];
      readonly wrapHex: string;
    }
  /**
   * randomBytes replaced by a recorder (bytes derived from `seed`); runs each operation once
   * and replies with the calls each one made (see RecordedStep).
   */
  | {
      readonly mode: 'random';
      readonly seed: string;
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly kmsKeyring: string;
      readonly kmsKeyId: string;
      readonly values: readonly FieldValue[];
      readonly wrapHex: readonly string[];
    };

export type ChildReply =
  | { readonly error: string }
  | { readonly ciphertexts: string[] }
  | {
      readonly versions: number[];
      readonly decrypted: string[];
      readonly indexes: string[];
      readonly unwrappedHex: string[];
    }
  | { readonly keyrings: string[]; readonly ciphertexts: string[]; readonly wrapped: string[] }
  | { readonly outcomes: string[] }
  | { readonly steps: RecordedStep[] };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Known bytes for the recorder: SHA-256 blocks of seed, call number and block number. */
function recordedBytes(seed: string, call: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  let filled = 0;
  for (let block = 0; filled < size; block += 1) {
    filled += createHash('sha256')
      .update(`${seed}#${String(call)}#${String(block)}`)
      .digest()
      .copy(out, filled);
  }
  return out;
}

/** Replaces randomBytes before the module under test is loaded; returns the call log. */
function installRecorder(seed: string): RandomCall[] {
  const calls: RandomCall[] = [];
  const require = createRequire(import.meta.url);
  const nodeCrypto = require('node:crypto') as { randomBytes: unknown };
  nodeCrypto.randomBytes = (size: number, callback?: (e: Error | null, b: Buffer) => void) => {
    const bytes = recordedBytes(seed, calls.length, size);
    calls.push({ size, hex: bytes.toString('hex') });
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, bytes));
      return undefined;
    }
    return bytes;
  };
  syncBuiltinESMExports();
  return calls;
}

async function outcomeOf(mod: CryptoModule, run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof mod.FieldCryptoError ? error.code : 'other error';
  }
  return 'returned';
}

async function exercise(
  mod: CryptoModule,
  kit: KitModule,
  request: Extract<ChildRequest, { mode: 'exercise' }>,
): Promise<ChildReply> {
  const provider = new mod.LocalKeyProvider(
    Buffer.from(request.masterKeyHex, 'hex'),
    request.keyId,
  );
  const created = await mod.createWrappedKeyring(provider);
  const stored = await mod.rotateDataKey(created, provider);
  const crypto = await mod.openFieldCrypto(JSON.parse(JSON.stringify(stored)), provider);
  const old = await mod.openFieldCrypto(created, provider);
  const outcomes: string[] = [];
  for (const { text, context } of request.values) {
    const ciphertext = crypto.encrypt(text, context);
    crypto.decrypt(ciphertext, context);
    crypto.keyVersionOf(ciphertext);
    crypto.needsReencrypt(ciphertext);
    crypto.blindIndex(text, context);
    crypto.decrypt(crypto.reencrypt(old.encrypt(text, context), context), context);
    const unknownVersion = ciphertext.replace(/^v1\.[0-9]+\./, 'v1.99.');
    outcomes.push(
      await outcomeOf(mod, () => crypto.decrypt(ciphertext, `${context}.other`)),
      await outcomeOf(mod, () => crypto.decrypt(unknownVersion, context)),
      await outcomeOf(mod, () => crypto.decrypt(text, context)),
      await outcomeOf(mod, () => crypto.encrypt(text, `${context} with space`)),
      await outcomeOf(mod, () => crypto.blindIndex(`${text}\ud800`, context)),
      await outcomeOf(mod, () => crypto.keyVersionOf(text)),
      await outcomeOf(mod, () => crypto.needsReencrypt(text)),
      await outcomeOf(mod, () => crypto.reencrypt(text, context)),
      await outcomeOf(mod, () => crypto.reencrypt(ciphertext, `${context} with space`)),
    );
  }
  const key = Buffer.from(request.wrapHex, 'hex');
  const wrapped = await provider.wrapKey(key);
  await provider.unwrapKey(wrapped);
  const otherMaster = Buffer.from(request.masterKeyHex, 'hex').map((byte) => byte ^ 0xff);
  const wrongProvider = new mod.LocalKeyProvider(otherMaster, request.keyId);
  const secret = request.values.map((v) => v.text).join(' ');
  const failing = (how: 'reject-wrap' | 'throw-wrap' | 'reject-unwrap' | 'throw-unwrap') =>
    new kit.FailingKms(new kit.FakeKms(request.keyId), how, secret);
  outcomes.push(
    await outcomeOf(mod, () => wrongProvider.unwrapKey(wrapped)),
    await outcomeOf(mod, () => provider.unwrapKey(request.wrapHex)),
    await outcomeOf(mod, () => provider.wrapKey(new Uint8Array(0))),
    await outcomeOf(mod, () => mod.openFieldCrypto(stored, wrongProvider)),
    await outcomeOf(mod, () => mod.openFieldCrypto({ ...stored, data_keys: [] }, provider)),
    await outcomeOf(mod, () => new mod.LocalKeyProvider(key.subarray(0, 16), request.keyId)),
    await outcomeOf(mod, () => mod.createWrappedKeyring(failing('reject-wrap'))),
    await outcomeOf(mod, () => mod.rotateDataKey(stored, failing('throw-wrap'))),
    await outcomeOf(mod, () => mod.openFieldCrypto(stored, failing('reject-unwrap'))),
    await outcomeOf(mod, () => mod.openFieldCrypto(stored, failing('throw-unwrap'))),
  );
  return { outcomes };
}

async function random(
  mod: CryptoModule,
  kit: KitModule,
  calls: RandomCall[],
  request: Extract<ChildRequest, { mode: 'random' }>,
): Promise<ChildReply> {
  type Keyring = Parameters<CryptoModule['openFieldCrypto']>[0];
  const steps: RecordedStep[] = [];
  /** Runs one operation and records the randomBytes calls made while it ran. */
  async function step<T>(
    op: string,
    run: () => T | Promise<T>,
    show: (value: T) => string,
  ): Promise<T> {
    const from = calls.length;
    const value = await run();
    steps.push({ op, calls: calls.slice(from), result: show(value) });
    return value;
  }
  const asText = (value: string): string => value;
  const asJson = (value: unknown): string => JSON.stringify(value);
  const opened = (): string => 'opened';

  // Field encryption under a keyring the parent knows (wrapped by the in-test KMS stand-in).
  const kms = new kit.FakeKms(request.kmsKeyId);
  const keyring = JSON.parse(request.kmsKeyring) as Keyring;
  const crypto = await step('open', () => mod.openFieldCrypto(keyring, kms), opened);
  for (const { text, context } of request.values) {
    const ciphertext = await step('encrypt', () => crypto.encrypt(text, context), asText);
    await step('decrypt', () => crypto.decrypt(ciphertext, context), asText);
    await step('blindIndex', () => crypto.blindIndex(text, context), asText);
    await step('keyVersionOf', () => crypto.keyVersionOf(ciphertext), asJson);
    await step('needsReencrypt', () => crypto.needsReencrypt(ciphertext), asJson);
  }
  // Keys generated for the in-test KMS, which records the plain keys it is asked to wrap.
  const kmsCreated = await step('kmsCreate', () => mod.createWrappedKeyring(kms), asJson);
  await step('kmsRotate', () => mod.rotateDataKey(kmsCreated, kms), asJson);
  steps.push({
    op: 'kmsPlainKeys',
    calls: [],
    result: asJson(kms.wrappedPlainKeys.map((key) => key.toString('hex'))),
  });

  // LocalKeyProvider: wrapping, a new keyring, a rotation, re-encryption under the new key.
  const master = Buffer.from(request.masterKeyHex, 'hex');
  const local = await step(
    'construct',
    () => new mod.LocalKeyProvider(master, request.keyId),
    (provider) => provider.keyId,
  );
  for (const hex of request.wrapHex) {
    const wrapped = await step('wrapKey', () => local.wrapKey(Buffer.from(hex, 'hex')), asText);
    await step(
      'unwrapKey',
      async () => Buffer.from(await local.unwrapKey(wrapped)).toString('hex'),
      asText,
    );
  }
  const created = await step('localCreate', () => mod.createWrappedKeyring(local), asJson);
  const rotated = await step('localRotate', () => mod.rotateDataKey(created, local), asJson);
  const first = request.values[0] ?? { text: 'x', context: 'c' };
  // Written under version 1 outside any recorded step, then re-encrypted under the new version.
  const old = (await mod.openFieldCrypto(created, local)).encrypt(first.text, first.context);
  const current = await step('localOpen', () => mod.openFieldCrypto(rotated, local), opened);
  await step('reencrypt', () => current.reencrypt(old, first.context), asText);
  return { steps };
}

async function handle(request: ChildRequest): Promise<ChildReply> {
  const calls = request.mode === 'random' ? installRecorder(request.seed) : [];
  const mod = (await import(MODULE_UNDER_TEST)) as CryptoModule;
  const kit = (await import('./kit.ts')) as KitModule;
  if (request.mode === 'random') return random(mod, kit, calls, request);
  if (request.mode === 'exercise') return exercise(mod, kit, request);
  if (request.mode === 'encrypt') {
    const crypto = await mod.openFieldCrypto(
      JSON.parse(request.keyring) as Parameters<CryptoModule['openFieldCrypto']>[0],
      new kit.FakeKms(request.kmsKeyId),
    );
    return { ciphertexts: request.values.map((v) => crypto.encrypt(v.text, v.context)) };
  }
  const provider = new mod.LocalKeyProvider(
    Buffer.from(request.masterKeyHex, 'hex'),
    request.keyId,
  );
  if (request.mode === 'recover') {
    const crypto = await mod.openFieldCrypto(
      JSON.parse(request.keyring) as Parameters<CryptoModule['openFieldCrypto']>[0],
      provider,
    );
    const unwrappedHex: string[] = [];
    for (const wrapped of request.unwrap) {
      unwrappedHex.push(Buffer.from(await provider.unwrapKey(wrapped)).toString('hex'));
    }
    return {
      versions: request.decrypt.map((c) => crypto.keyVersionOf(c.ciphertext)),
      decrypted: request.decrypt.map((c) => crypto.decrypt(c.ciphertext, c.context)),
      indexes: request.index.map((v) => crypto.blindIndex(v.text, v.context)),
      unwrappedHex,
    };
  }
  const keyrings: string[] = [];
  let ciphertexts: string[] = [];
  for (let i = 0; i < request.keyrings; i += 1) {
    const keyring = await mod.rotateDataKey(await mod.createWrappedKeyring(provider), provider);
    keyrings.push(JSON.stringify(keyring));
    if (i === 0) {
      const crypto = await mod.openFieldCrypto(keyring, provider);
      ciphertexts = request.encrypt.map((v) => crypto.encrypt(v.text, v.context));
    }
  }
  const wrapped: string[] = [];
  for (const hex of request.wrapHex) wrapped.push(await provider.wrapKey(Buffer.from(hex, 'hex')));
  return { keyrings, ciphertexts, wrapped };
}

let reply: ChildReply;
try {
  reply = await handle(JSON.parse(await readStdin()) as ChildRequest);
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  reply = { error: typeof code === 'string' ? code : `other error: ${String(error)}` };
}
process.stdout.write(JSON.stringify(reply));
