// Child process of the prior identity keyring output rule test (B1-27e; §4 of
// apps/api/src/modules/platform/config/keyring-prior-identity.ts: openPriorIdentityFieldCrypto
// writes nothing at all). Started with plain `node <this file>` (Node's own type stripping): a
// process whose whole stdout and stderr the parent sees, unlike a Vitest worker.
// One JSON request on stdin, one JSON reply on stdout (exactly that, no line feed), nothing on
// stderr. The reply carries only codes, numbers and booleans — never a value it was given — so any
// other byte on stdout or stderr was printed by the code under test. Import only the types of this
// file (`import type`): importing it for real would run it and wait for stdin.

type PriorModule =
  typeof import('../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts');

const PRIOR_MODULE = '../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts';

type ChildKeyring =
  | { readonly provider: 'local'; readonly keyringFile: string; readonly masterKeyFile: string }
  | { readonly provider: 'kms'; readonly keyringFile: string };

export interface PriorChildCase {
  readonly appEnv: 'local' | 'test' | 'staging' | 'prod';
  readonly prior: ChildKeyring | null;
  readonly keyring: ChildKeyring | null;
}

export interface PriorChildRequest {
  /** Cases for openPriorIdentityFieldCrypto, run one after the other. */
  readonly open: readonly PriorChildCase[];
  /** Plaintexts the opened ciphers encrypt and decrypt (never echoed). */
  readonly plaintexts: readonly string[];
  /** The fixed message of every error code (from the parent's copy of the contract). */
  readonly messages: Readonly<Record<string, string>>;
}

/** One open case: the error's code (`other` for anything else), or what the cipher did. */
export type PriorChildResult =
  | { readonly code: string; readonly exact: boolean }
  | { readonly opened: true; readonly currentKeyVersion: number; readonly roundTrips: boolean };

export type PriorChildReply =
  { readonly error: string } | { readonly open: readonly PriorChildResult[] };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<PriorChildReply> {
  const request = JSON.parse(await readStdin()) as PriorChildRequest;
  const prior = (await import(new URL(PRIOR_MODULE, import.meta.url).href)) as PriorModule;
  const open: PriorChildResult[] = [];
  for (const item of request.open) {
    try {
      const fc = await prior.openPriorIdentityFieldCrypto(item.appEnv, item.prior, item.keyring);
      let roundTrips = true;
      for (const plaintext of request.plaintexts) {
        const ciphertext = fc.encrypt(plaintext, 'prior_identity.id_no');
        if (fc.decrypt(ciphertext, 'prior_identity.id_no') !== plaintext) roundTrips = false;
      }
      open.push({ opened: true, currentKeyVersion: fc.currentKeyVersion, roundTrips });
    } catch (error) {
      const known = error instanceof prior.PriorIdentityKeyringError;
      open.push({
        code: known ? error.code : 'other',
        exact:
          known &&
          error.message === request.messages[error.code] &&
          Reflect.ownKeys(error).every((key) =>
            ['stack', 'message', 'name', 'code'].includes(String(key)),
          ),
      });
    }
  }
  return { open };
}

main().then(
  (reply) => {
    process.stdout.write(JSON.stringify(reply));
  },
  (error: unknown) => {
    const name = error instanceof Error ? error.name : 'non-error';
    process.stdout.write(JSON.stringify({ error: `child failed: ${name}` }));
  },
);
