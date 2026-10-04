// Where the field-encryption keyring comes from (ADR-0001 §2 鉴权与密钥: 自有 KeyProvider 接口，本地用
// 文件密钥实现，云上用 KMS 实现; ADR-0001 §2 配置校验: zod，启动时校验环境变量; 规划/02 §12.3, §12.6
// 「数据加密主密钥 | KMS | 通过信封加密间接使用」; 规划/11 §8「真实密钥被本地栈加载」; 规划/08 BR-ID-33).
// Contract written by the rule-test author, implemented by B1-01k.
// The rule tests in test/spec/platform/crypto/wiring-*.test.ts call
// `loadConfig` of ./config.ts and import the types of this file by path; the variable names, the
// problem texts and the `AppConfig.keyring` shape written here are the contract. Choices that no
// document fixes are marked 待编排会话确认 (the suggested default is what is written).
//
// 1. Variables (read by `loadConfig(env)` of ./config.ts, never from `process.env` directly; a
//    variable set to '' counts as unset, like every other variable of loadConfig)
//
//      FIELD_KEY_PROVIDER     `local` | `kms` — who holds the master key (key-encryption key)
//      FIELD_KEYRING_FILE     absolute path of the stored keyring: the JSON text of a
//                             `WrappedKeyring` (../crypto/index.ts). Holds only wrapped keys, so it
//                             is not a secret by itself
//      FIELD_MASTER_KEY_FILE  absolute path of the local master key file (provider `local` only);
//                             its format is in ./keyring-startup.ts
//
//    待编排会话确认: (a) the three names — no document names these variables; (b) the keyring is a
//    file for both providers (the KMS provider of a later task only replaces who unwraps the keys).
//
// 2. Which APP_ENV needs it. All five entries use the same `loadConfig`, so the rule is the same for
//    api / stream / admin / worker / payout: every entry may have to decrypt or index a phone
//    number, an id number or a payout account (BR-ID-33; api: login and payout account, admin:
//    reveal, worker: SMS and notifications, payout: the payout account, stream / api / worker: the
//    encrypted `union_credentials` of 规划/02 §12.6).
//
//      APP_ENV        FIELD_KEY_PROVIDER unset             local                   kms
//      local, test    allowed: `keyring` is null, the     allowed                 refused
//                     process has no FIELD_CRYPTO
//      staging        refused                              refused                 allowed (opening
//                                                                                  refuses, §4)
//      prod           refused                              refused                 allowed (opening
//                                                                                  refuses, §4)
//
//    待编排会话确认: (c) local / test may run without a keyring — needed now because the existing
//    entry smoke test, bootstrap and contract tests (outside this task's paths) start entries with
//    APP_ENV=test and no keyring variables; once `pnpm dev:stack` creates a local keyring it can
//    become required everywhere. (e) kms is refused in local / test: those environments never
//    load real keys (规划/11 §8).
//    staging refuses the local provider like prod (rule-test review round 1, 2026-10-04): ADR-0001
//    §2 says 本地用文件密钥实现，云上用 KMS 实现 and staging runs in the cloud (ECS, ADR-0002); the
//    technical baseline is the ADR. Until the KMS provider lands, staging therefore cannot start —
//    this is expected, not a defect.
//
// 3. Problems (`ConfigError.problems` of loadConfig). They never contain a value of any variable.
//    The keyring problems come after every other problem of loadConfig, in the order
//    FIELD_KEY_PROVIDER, FIELD_KEYRING_FILE, FIELD_MASTER_KEY_FILE, at most one per variable.
//    They are checked whenever APP_ENV itself is valid (also when another variable is invalid).
//
//      FIELD_KEY_PROVIDER
//        unset, APP_ENV staging / prod  `FIELD_KEY_PROVIDER: must be set when APP_ENV=<appEnv>`
//        not exactly `local` or `kms`   `FIELD_KEY_PROVIDER: must be local or kms`
//        local, APP_ENV staging / prod  `FIELD_KEY_PROVIDER: local must not be used when
//                                        APP_ENV=<appEnv> (cloud keys come from KMS)`
//        kms, APP_ENV local / test      `FIELD_KEY_PROVIDER: kms must not be used when
//                                        APP_ENV=<appEnv> (local and test never load real keys)`
//      FIELD_KEYRING_FILE
//        provider unset, variable set   `FIELD_KEYRING_FILE: must not be set without
//                                        FIELD_KEY_PROVIDER`
//        provider local / kms, unset    `FIELD_KEYRING_FILE: must be set when FIELD_KEY_PROVIDER
//                                        is set`
//        provider local / kms, not an   `FIELD_KEYRING_FILE: must be an absolute path`
//        absolute path
//      FIELD_MASTER_KEY_FILE
//        provider unset, variable set   `FIELD_MASTER_KEY_FILE: must not be set without
//                                        FIELD_KEY_PROVIDER`
//        provider local, unset          `FIELD_MASTER_KEY_FILE: must be set when
//                                        FIELD_KEY_PROVIDER=local`
//        provider local, not absolute   `FIELD_MASTER_KEY_FILE: must be an absolute path`
//        provider kms, variable set     `FIELD_MASTER_KEY_FILE: must not be set when
//                                        FIELD_KEY_PROVIDER=kms`
//      (Each text above is one line; the line breaks here are only for the width of this comment.)
//      When FIELD_KEY_PROVIDER is set but not `local` / `kms`, the two file variables are not
//      checked at all. When it is `local` or `kms`, the file variables are checked even if the
//      provider itself is refused for this APP_ENV.
//      An absolute path starts with `/` and contains no control character (U+0000..U+001F,
//      U+007F); nothing else is checked here (whether the file exists is checked when it is
//      opened, ./keyring-startup.ts).
//
// 4. Result. `AppConfig` gains `keyring: KeyringConfig | null` (null exactly when
//    FIELD_KEY_PROVIDER is unset in local / test). The paths are kept exactly as given. Opening
//    happens later, while the Nest providers are created (./keyring-startup.ts); `kms` passes
//    loadConfig in staging / prod and is refused there, because no KMS provider exists yet.
//
//    The unit tests of ./config.test.ts that compare a whole AppConfig, or all problems of a prod
//    environment, predate this contract: update them to it (they are inside this task's paths).
//
// Rules for the implementation: erasable syntax only (this directory is also compiled by the
// `test` project), `import type` for type-only imports, relative imports with the `.ts` extension.

import { z } from 'zod';
import type { AppEnv } from './app-env.ts';

export const KEY_PROVIDER_NAMES = ['local', 'kms'] as const;
export type KeyProviderName = (typeof KEY_PROVIDER_NAMES)[number];

const keyringEnvSchema = z.object({
  FIELD_KEY_PROVIDER: z.string().default(''),
  FIELD_KEYRING_FILE: z.string().default(''),
  FIELD_MASTER_KEY_FILE: z.string().default(''),
});
const providerSchema = z.enum(KEY_PROVIDER_NAMES);
const pathSchema = z
  .string()
  .startsWith('/')
  .refine((path) =>
    Array.from(path).every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }),
  );

/** `AppConfig.keyring` when a provider is configured. Paths are absolute, as given. */
export type KeyringConfig =
  | {
      readonly provider: 'local';
      readonly keyringFile: string;
      readonly masterKeyFile: string;
    }
  | {
      readonly provider: 'kms';
      readonly keyringFile: string;
    };

/**
 * The keyring part of `loadConfig`: the `keyring` value (meaningful only when `problems` is
 * empty) and the problems of §3, in order. Reads only the three FIELD_* names and APP_ENV's
 * already validated value.
 */
export function readKeyringConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly keyring: KeyringConfig | null; readonly problems: readonly string[] } {
  const values = keyringEnvSchema.parse(env);
  const provider = values.FIELD_KEY_PROVIDER;
  const keyringFile = values.FIELD_KEYRING_FILE;
  const masterKeyFile = values.FIELD_MASTER_KEY_FILE;
  const cloud = appEnv === 'staging' || appEnv === 'prod';
  const problems: string[] = [];

  if (provider === '') {
    if (cloud) problems.push(`FIELD_KEY_PROVIDER: must be set when APP_ENV=${appEnv}`);
    for (const name of ['FIELD_KEYRING_FILE', 'FIELD_MASTER_KEY_FILE'] as const) {
      if (values[name] !== '') problems.push(`${name}: must not be set without FIELD_KEY_PROVIDER`);
    }
    return { keyring: null, problems };
  }
  const parsedProvider = providerSchema.safeParse(provider);
  if (!parsedProvider.success) {
    return { keyring: null, problems: ['FIELD_KEY_PROVIDER: must be local or kms'] };
  }
  if (provider === 'local' && cloud) {
    problems.push(
      `FIELD_KEY_PROVIDER: local must not be used when APP_ENV=${appEnv} (cloud keys come from KMS)`,
    );
  } else if (provider === 'kms' && !cloud) {
    problems.push(
      `FIELD_KEY_PROVIDER: kms must not be used when APP_ENV=${appEnv} (local and test never load real keys)`,
    );
  }
  if (keyringFile === '') {
    problems.push('FIELD_KEYRING_FILE: must be set when FIELD_KEY_PROVIDER is set');
  } else if (!pathSchema.safeParse(keyringFile).success) {
    problems.push('FIELD_KEYRING_FILE: must be an absolute path');
  }
  if (provider === 'local') {
    if (masterKeyFile === '') {
      problems.push('FIELD_MASTER_KEY_FILE: must be set when FIELD_KEY_PROVIDER=local');
    } else if (!pathSchema.safeParse(masterKeyFile).success) {
      problems.push('FIELD_MASTER_KEY_FILE: must be an absolute path');
    }
  } else if (masterKeyFile !== '') {
    problems.push('FIELD_MASTER_KEY_FILE: must not be set when FIELD_KEY_PROVIDER=kms');
  }
  return {
    keyring:
      provider === 'local'
        ? { provider, keyringFile, masterKeyFile }
        : { provider: 'kms', keyringFile },
    problems,
  };
}
