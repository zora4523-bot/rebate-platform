// Child process of the restart rule tests in restart.test.ts (规划/08 BR-ID-33). It is started
// with plain `node <this file>`: a new process that imports the module under test anew, so
// nothing the parent holds in memory (a module-level IV counter, a table of wrapped keys) exists
// here. Only text crosses the process boundary: one JSON request on stdin (a serialised keyring,
// ciphertexts, a key id, master-key bytes in hex), one JSON reply on stdout.
// Any failure is replied as { "error": "<FieldCryptoError code or message>" }, so that the
// parent's single assertion shows it. Import only the types of this file (`import type`):
// importing it for real would run it and wait for stdin.
import {
  FieldCryptoError,
  LocalKeyProvider,
  type KeyProvider,
  type WrappedKeyring,
  createWrappedKeyring,
  openFieldCrypto,
  rotateDataKey,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { FakeKms } from './kit.ts';

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
  /** With a LocalKeyProvider from the master-key bytes: a new keyring, ciphertexts, wrapped keys. */
  | {
      readonly mode: 'produce';
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly encrypt: readonly FieldValue[];
      readonly wrapHex: readonly string[];
    }
  /**
   * Runs every operation once per value, successful and refused ones, and replies only with the
   * outcomes of the refused calls: the parent checks what the process printed besides that.
   */
  | {
      readonly mode: 'exercise';
      readonly masterKeyHex: string;
      readonly keyId: string;
      readonly keyring: string;
      readonly values: readonly FieldValue[];
      readonly wrapHex: string;
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
  | { readonly keyring: string; readonly ciphertexts: string[]; readonly wrapped: string[] }
  | { readonly outcomes: string[] };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function localProvider(masterKeyHex: string, keyId: string): KeyProvider {
  return new LocalKeyProvider(Buffer.from(masterKeyHex, 'hex'), keyId);
}

/** The FieldCryptoError code of a refused call, `refused` for a FieldCryptoError without a
 * fixed code, `returned` when it was not refused, `other error` for anything else. */
async function outcomeOf(run: () => unknown, anyCode = false): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof FieldCryptoError)) return 'other error';
    return anyCode ? 'refused' : error.code;
  }
  return 'returned';
}

async function exercise(request: Extract<ChildRequest, { mode: 'exercise' }>): Promise<ChildReply> {
  const provider = localProvider(request.masterKeyHex, request.keyId);
  const stored = JSON.parse(request.keyring) as WrappedKeyring;
  const crypto = await openFieldCrypto(stored, provider);
  const rotated = await openFieldCrypto(await rotateDataKey(stored, provider), provider);
  const outcomes: string[] = [];
  for (const { text, context } of request.values) {
    const ciphertext = crypto.encrypt(text, context);
    crypto.decrypt(ciphertext, context);
    crypto.keyVersionOf(ciphertext);
    crypto.needsReencrypt(ciphertext);
    crypto.blindIndex(text, context);
    rotated.decrypt(rotated.reencrypt(ciphertext, context), context);
    outcomes.push(
      await outcomeOf(() => crypto.decrypt(ciphertext, `${context}.other`)),
      await outcomeOf(() => crypto.encrypt(text, `${context} with space`)),
      await outcomeOf(() => crypto.blindIndex(`${text}\ud800`, context)),
      await outcomeOf(() => crypto.decrypt(text, context)),
    );
  }
  const wrapped = await provider.wrapKey(Buffer.from(request.wrapHex, 'hex'));
  await provider.unwrapKey(wrapped);
  const otherMaster = Buffer.from(request.masterKeyHex, 'hex').map((byte) => byte ^ 0xff);
  const wrongProvider = new LocalKeyProvider(otherMaster, request.keyId);
  outcomes.push(
    await outcomeOf(() => wrongProvider.unwrapKey(wrapped), true),
    await outcomeOf(() => openFieldCrypto(stored, wrongProvider), true),
  );
  return { outcomes };
}

async function handle(request: ChildRequest): Promise<ChildReply> {
  if (request.mode === 'exercise') return exercise(request);
  if (request.mode === 'encrypt') {
    const crypto = await openFieldCrypto(
      JSON.parse(request.keyring) as WrappedKeyring,
      new FakeKms(request.kmsKeyId),
    );
    return { ciphertexts: request.values.map((v) => crypto.encrypt(v.text, v.context)) };
  }
  if (request.mode === 'recover') {
    const provider = localProvider(request.masterKeyHex, request.keyId);
    const crypto = await openFieldCrypto(JSON.parse(request.keyring) as WrappedKeyring, provider);
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
  const provider = localProvider(request.masterKeyHex, request.keyId);
  const keyring = await createWrappedKeyring(provider);
  const crypto = await openFieldCrypto(keyring, provider);
  const wrapped: string[] = [];
  for (const hex of request.wrapHex) wrapped.push(await provider.wrapKey(Buffer.from(hex, 'hex')));
  return {
    keyring: JSON.stringify(keyring),
    ciphertexts: request.encrypt.map((v) => crypto.encrypt(v.text, v.context)),
    wrapped,
  };
}

let reply: ChildReply;
try {
  reply = await handle(JSON.parse(await readStdin()) as ChildRequest);
} catch (error) {
  reply = {
    error: error instanceof FieldCryptoError ? error.code : `other error: ${String(error)}`,
  };
}
process.stdout.write(JSON.stringify(reply));
