// B1-01zd / B1-01zi / BR-ID-33: initialize a local WrappedKeyring from an existing master key file
// (规划仓库 docs/adr/0003-staging字段加密主密钥用文件.md: staging keeps its field-encryption master key in a
// file on the node; prod uses KMS only).
//
// Usage (in the rebate-platform root; no environment variables are read):
//
//   (umask 077 && set -o noclobber && openssl rand -hex 32 > /path/to/master.hex)
//   node apps/api/scripts/keyring-init.ts <master-key-file> <output-file>
//
// The first command only creates a new master key file (mode 0600): when the file already exists
// the shell refuses the redirection, exits non-zero and leaves the file untouched. Never replace an
// existing master key: everything encrypted under it (via the keyring) can no longer be decrypted.
//
// Then set FIELD_KEY_PROVIDER=local, FIELD_MASTER_KEY_FILE=<master-key-file> and
// FIELD_KEYRING_FILE=<output-file> (apps/api/src/modules/platform/config/keyring.ts).
//
// Master format: exactly 64 lowercase hex characters, optionally followed by one LF, as specified
// by config/keyring-startup.ts (the same reader is used). The generated key_id is `local`.
// Each run creates a fresh random data key and blind-index key. The keyring is first written to an
// exclusively created temporary file (mode 0o600, independent of the umask) in the output's
// directory and fsynced; only then it is hard-linked to the output path, which fails if that path
// exists, so the output path never holds a partial keyring and an existing output is never
// overwritten. The temporary file is removed on success and on any failure.
// Nothing printed contains master, data or blind-index key material, a path or a file's content.
// Exit codes: 0 created, 1 any failure (usage, unreadable / invalid master key, existing output).
// Importing this module does not run the command or inspect process arguments.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalKeyProvider } from '../src/modules/platform/config/keyring-startup.ts';
import { createWrappedKeyring } from '../src/modules/platform/crypto/index.ts';

const USAGE = 'usage: node apps/api/scripts/keyring-init.ts <master-key-file> <output-file>\n';

/** Resolves after creating the file; rejects on invalid input or an existing output. */
export async function initLocalKeyring(masterKeyFile: string, outputFile: string): Promise<void> {
  const provider = await readLocalKeyProvider(masterKeyFile);
  const keyring = await createWrappedKeyring(provider);
  const text = `${JSON.stringify(keyring, null, 2)}\n`;
  // Same directory as the output: link() cannot cross file systems. The temporary name does not
  // embed the output name, so any legal output name (up to NAME_MAX bytes) keeps it short.
  const directory = dirname(outputFile);
  const temporary = join(directory, `.keyring-init.${randomBytes(16).toString('hex')}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic and never overwriting: an existing output (or symlink) fails with EEXIST untouched.
    await link(temporary, outputFile);
  } finally {
    // The output (if placed) is another name for the same inode; the temporary name always goes.
    await unlink(temporary).catch(() => undefined);
  }
  await syncDirectory(directory);
}

/** Best effort: persists the new directory entry; some file systems refuse fsync on a directory. */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The keyring is already complete at the output path; durability of the entry is best effort.
  }
}

/** CLI arguments exclude node and script paths; returns 0 on success, 1 on failure. */
export async function main(args: readonly string[]): Promise<number> {
  const [masterKeyFile, outputFile, ...rest] = args;
  if (
    masterKeyFile === undefined ||
    outputFile === undefined ||
    masterKeyFile === '' ||
    outputFile === '' ||
    rest.length > 0
  ) {
    process.stderr.write(USAGE);
    return 1;
  }
  try {
    await initLocalKeyring(masterKeyFile, outputFile);
  } catch (error) {
    process.stderr.write(`keyring-init failed: ${describe(error)}\n`);
    return 1;
  }
  process.stdout.write('keyring-init: created the local keyring (key_id local, version 1)\n');
  return 0;
}

/** Fixed texts only: file-system errors quote paths, so only their code is shown. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'KeyringStartupError') return error.message;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'EEXIST') return 'the output file already exists (it was not changed)';
  if (/^E[A-Z]+$/.test(code)) return `the output file cannot be created (${code})`;
  return 'unexpected error';
}

function executedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('keyring-init failed: unexpected error\n');
      process.exitCode = 1;
    },
  );
}
