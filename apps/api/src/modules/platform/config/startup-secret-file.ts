// Reading one staging credential secret file at startup (shared by ./pdd-startup.ts of B1-04t and
// ./taobao-startup.ts of B1-04k). One open of the path, regular file only, at most `maxBytes`,
// strict UTF-8, one trailing `\n` or `\r\n` removed, empty afterwards is invalid. The failure only
// says which of two reasons applied: never the path, the content or the underlying error; the
// caller turns it into its own fixed-text error. Read buffers are zeroed after use.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type StartupSecretFileFailure = 'secret_unreadable' | 'secret_invalid';

/** Internal marker; never leaves this module (callers get `fail(reason)` instead). */
class SecretFileFailure {
  readonly reason: StartupSecretFileFailure;

  constructor(reason: StartupSecretFileFailure) {
    this.reason = reason;
  }
}

async function readBytes(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new SecretFileFailure('secret_unreadable');
    if (stat.size > maxBytes) throw new SecretFileFailure('secret_invalid');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      buffer.fill(0);
      throw new SecretFileFailure('secret_invalid');
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** The secret text of `path`, or `throw fail(reason)` (the original error is dropped). */
export async function readStartupSecretFile(
  path: string,
  maxBytes: number,
  fail: (reason: StartupSecretFileFailure) => Error,
): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readBytes(path, maxBytes);
  } catch (error) {
    throw fail(error instanceof SecretFileFailure ? error.reason : 'secret_unreadable');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fail('secret_invalid');
  } finally {
    bytes.fill(0);
  }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text === '') throw fail('secret_invalid');
  return text;
}
