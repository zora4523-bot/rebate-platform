// Staging test phone numbers with a fixed SMS code (B1-02zza, FU-STAGING-TEST-PHONE; approvals #48;
// orchestrator ruling D10-611). Only APP_ENV=staging honours them; every other environment is hard
// off. The numbers and the code come from the node, never from the repository.
//
// readStagingTestPhoneConfig (pure, loadConfig's part; never echoes a value):
//   - STAGING_TEST_PHONES: comma-separated normalised mainland numbers (^1[3-9][0-9]{9}$), 1 to 10
//     items, no empty item, no duplicate;
//   - STAGING_TEST_SMS_CODE_FILE: path of the node file that holds the fixed code;
//   - unset or empty string: null, no problem, in every environment;
//   - local / test / prod: either one set → a problem (refused at startup);
//   - staging: both or neither; a list that breaks the rules above → a problem. The file itself is
//     not opened here.
// openStagingTestPhones (the startup factory): reads the code file once (regular file only, one
// trailing newline removed, exactly 6 ASCII digits). Failures name STAGING_TEST_SMS_CODE_FILE
// and a reason, never the path, the content or the code.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports.
import type { AppEnv } from './app-env.ts';

/** What loadConfig keeps: the numbers and the path of the code file (never the code). */
export interface StagingTestPhoneConfig {
  /** Normalised 11-digit numbers, in the order given, at most 10, no duplicate. */
  readonly phones: readonly string[];
  /** Path of the node file holding the fixed 6-digit code. */
  readonly codeFile: string;
}

export interface StagingTestPhoneConfigResult {
  readonly stagingTestPhones: StagingTestPhoneConfig | null;
  readonly problems: readonly string[];
}

/** The runtime form the SMS code service gets (staging only): the numbers and the fixed code. */
export interface StagingTestPhones {
  readonly phones: readonly string[];
  readonly code: string;
}

export function readStagingTestPhoneConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): StagingTestPhoneConfigResult {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readStagingTestPhoneConfig');
}

export function openStagingTestPhones(config: StagingTestPhoneConfig): Promise<StagingTestPhones> {
  void config;
  throw new Error('NotImplemented: openStagingTestPhones');
}
