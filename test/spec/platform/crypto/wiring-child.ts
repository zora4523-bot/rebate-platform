// Child process of the keyring wiring output rule tests (规划/08 BR-ID-33「日志…中不得出现明文」;
// §6 of apps/api/src/modules/platform/config/keyring-startup.ts: openConfiguredFieldCrypto writes
// nothing at all). It is started with plain `node <this file>` (Node's own type stripping): a
// process whose whole stdout and stderr the parent sees, unlike a Vitest worker.
// Only text crosses the process boundary: one JSON request on stdin, one JSON reply on stdout
// (exactly that, no line feed), nothing on stderr. The reply carries only codes, numbers and
// booleans — never a value it was given — so any other byte on stdout or stderr was printed by the
// code under test. Import only the types of this file (`import type`): importing it for real would
// run it and wait for stdin.

type StartupModule =
  typeof import('../../../../apps/api/src/modules/platform/config/keyring-startup.ts');
type ConfigModule = typeof import('../../../../apps/api/src/modules/platform/config/config.ts');

const STARTUP_MODULE = '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
const CONFIG_MODULE = '../../../../apps/api/src/modules/platform/config/config.ts';

export interface ChildOpenCase {
  readonly appEnv: 'local' | 'test' | 'staging' | 'prod';
  readonly keyring:
    | { readonly provider: 'local'; readonly keyringFile: string; readonly masterKeyFile: string }
    | { readonly provider: 'kms'; readonly keyringFile: string };
}

export interface WiringChildRequest {
  /** Cases for openConfiguredFieldCrypto, run one after the other. */
  readonly open: readonly ChildOpenCase[];
  /** Environments for loadConfig (their problems are counted, never echoed). */
  readonly config: readonly Readonly<Record<string, string>>[];
  /** Plaintexts the opened ciphers encrypt and decrypt (never echoed). */
  readonly plaintexts: readonly string[];
}

/** One open case: the error's code, or `opened` with what the cipher did. */
export type ChildOpenResult =
  | { readonly code: string; readonly exact: boolean }
  | {
      readonly opened: true;
      readonly currentKeyVersion: number;
      readonly roundTrips: boolean;
      readonly blindIndexStable: boolean;
    };

export type WiringChildReply =
  | { readonly error: string }
  | {
      readonly open: readonly ChildOpenResult[];
      /** Per config environment: the number of problems, or -1 when loadConfig returned. */
      readonly config: readonly number[];
    };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<WiringChildReply> {
  const request = JSON.parse(await readStdin()) as WiringChildRequest;
  const startup = (await import(new URL(STARTUP_MODULE, import.meta.url).href)) as StartupModule;
  const config = (await import(new URL(CONFIG_MODULE, import.meta.url).href)) as ConfigModule;
  const open: ChildOpenResult[] = [];
  for (const item of request.open) {
    try {
      const fc = await startup.openConfiguredFieldCrypto(item.appEnv, item.keyring);
      let roundTrips = true;
      let blindIndexStable = true;
      for (const plaintext of request.plaintexts) {
        const ciphertext = fc.encrypt(plaintext, 'users.phone');
        if (fc.decrypt(ciphertext, 'users.phone') !== plaintext) roundTrips = false;
        if (fc.blindIndex(plaintext, 'users.phone') !== fc.blindIndex(plaintext, 'users.phone')) {
          blindIndexStable = false;
        }
      }
      open.push({
        opened: true,
        currentKeyVersion: fc.currentKeyVersion,
        roundTrips,
        blindIndexStable,
      });
    } catch (error) {
      const isStartup = error instanceof startup.KeyringStartupError;
      open.push({
        code: isStartup ? error.code : 'other',
        exact:
          isStartup &&
          error.message === startup.KEYRING_STARTUP_MESSAGES[error.code] &&
          Reflect.ownKeys(error).every((key) =>
            ['stack', 'message', 'name', 'code'].includes(String(key)),
          ),
      });
    }
  }
  const counts: number[] = [];
  for (const env of request.config) {
    try {
      config.loadConfig(env);
      counts.push(-1);
    } catch (error) {
      counts.push(error instanceof config.ConfigError ? error.problems.length : -2);
    }
  }
  return { open, config: counts };
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
