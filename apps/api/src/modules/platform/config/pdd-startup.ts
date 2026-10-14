// Starting the real Pinduoduo adapter (B1-04t; approvals #28 ②; 规划/11 §8; 规划/02 §12.6).
// Called by the union module's async startup factory, once, while Nest creates the providers:
// the staging client_secret file is read here and the credentials are handed out from memory
// afterwards (changing or deleting the file later changes nothing). Same discipline as
// ./keyring-startup.ts: errors carry a fixed text per code, never the path, the file content,
// the client id or the underlying error (no `cause`); nothing is logged here; no process.env.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { AppEnv } from './app-env.ts';
import type { PddClientConfig } from './pdd.ts';

/** Largest client_secret file accepted. */
export const PDD_SECRET_FILE_MAX_BYTES = 4096;

export type PddStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export const PDD_STARTUP_MESSAGES: Readonly<Record<PddStartupErrorCode, string>> = Object.freeze({
  live_in_local:
    'the Pinduoduo live adapter must not start when APP_ENV is local or test (fake adapters only)',
  kms_unavailable:
    'the Pinduoduo live adapter needs the KMS credential source when APP_ENV is prod, which is not available yet',
  credentials_missing:
    'the Pinduoduo live adapter needs PDD_CLIENT_ID and PDD_CLIENT_SECRET_FILE when APP_ENV is staging',
  secret_unreadable: 'the Pinduoduo client secret file cannot be read',
  secret_invalid: 'the Pinduoduo client secret file is empty or not a valid secret',
});

/** Every startup refusal of the pdd live adapter; nothing else attached (no cause, no values). */
export class PddStartupError extends Error {
  readonly code: PddStartupErrorCode;

  constructor(code: PddStartupErrorCode) {
    super(PDD_STARTUP_MESSAGES[code]);
    this.name = 'PddStartupError';
    this.code = code;
  }
}

export interface PddClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Decides whether the pdd live adapter may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 * - local / test: refused (规划/11 §8; probing runs only in the owner's terminal scripts).
 * - prod: refused until the KMS source exists. TODO(规划/11 §4.5): KMS 取用 — blocked on 云 KMS 选型
 * - staging: both variables required; the file must be a regular, non-empty UTF-8 file.
 */
export async function openPddCredentials(
  appEnv: AppEnv,
  pdd: PddClientConfig | null | undefined,
): Promise<() => Promise<PddClientCredentials>> {
  if (appEnv === 'local' || appEnv === 'test') throw new PddStartupError('live_in_local');
  if (appEnv !== 'staging') throw new PddStartupError('kms_unavailable');
  if (pdd === null || pdd === undefined || pdd.clientId === '' || pdd.secretFile === '') {
    throw new PddStartupError('credentials_missing');
  }
  const clientSecret = await readSecretFile(pdd.secretFile);
  const credentials: PddClientCredentials = Object.freeze({
    clientId: pdd.clientId,
    clientSecret,
  });
  return async () => credentials;
}

/** One open of the path; trailing `\n` or `\r\n` removed once; empty afterwards is invalid. */
async function readSecretFile(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new PddStartupError('secret_unreadable');
      if (stat.size > PDD_SECRET_FILE_MAX_BYTES) throw new PddStartupError('secret_invalid');
      const buffer = Buffer.alloc(PDD_SECRET_FILE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > PDD_SECRET_FILE_MAX_BYTES) {
        buffer.fill(0);
        throw new PddStartupError('secret_invalid');
      }
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  } catch (error) {
    throw new PddStartupError(error instanceof PddStartupError ? error.code : 'secret_unreadable');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PddStartupError('secret_invalid');
  } finally {
    bytes.fill(0);
  }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text === '') throw new PddStartupError('secret_invalid');
  return text;
}
