// Rule tests: opening the configured keyring at startup — `openConfiguredFieldCrypto` of
// apps/api/src/modules/platform/config/keyring-startup.ts, §1–§3 and §6 of its contract (规划/08 BR-ID-33
// 字段级加密、KMS 信封加密、日志中不得出现明文; ADR-0001 §2「自有 KeyProvider 接口，本地用文件密钥实现，云上用
// KMS 实现」; 规划/02 §12.6「数据加密主密钥 | KMS | 通过信封加密间接使用」; 规划/11 §8). Every failure is
// asserted exactly (error class, code, fixed message, plain stack, no other property), so nothing
// of a path, a file or a key can ride along; the leak search of kit.ts is only a second net.
// Files are written by the tests into a fresh directory under <repo>/.tmp. Top-level it() only.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { KeyringConfig } from '../../../../apps/api/src/modules/platform/config/keyring.ts';
import { openConfiguredFieldCrypto } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  BLIND_KEY_LABEL,
  SAMPLES,
  leaksIn,
  parseLk1,
  referenceWrap,
  referenceBlindIndex,
  referenceDecrypt,
  referenceEncrypt,
  shapeProblems,
  testKey,
} from './kit.ts';
import {
  CURRENT_VERSION,
  OTHER_MASTER_LABEL,
  keyringDoc,
  makeDir,
  masterText,
  notUtf8,
  withNote,
  removeDir,
  secretsOf,
  settle,
  startupErrorProblems,
  writeFiles,
  type AppEnvName,
  type LocalFiles,
} from './wiring-kit.ts';
import type { KeyringStartupErrorCode } from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';

const KEYRING_FILE_MAX_BYTES = 1_048_576;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function fresh(label: string, contents: Parameters<typeof writeFiles>[1] = {}): LocalFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writeFiles(dir, contents);
}

function local(files: { masterFile: string; keyringFile: string }): KeyringConfig & {
  readonly provider: 'local';
} {
  return { provider: 'local', keyringFile: files.keyringFile, masterKeyFile: files.masterFile };
}

/** Problems of an opened FieldCrypto: shape, and that it holds exactly the test keyring's keys. */
function openedProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [`not an object: ${String(value)}`];
  const shape = shapeProblems(value, { fieldCrypto: CURRENT_VERSION });
  if (shape.length > 0) return shape;
  const fc = value as FieldCrypto;
  const problems: string[] = [];
  for (const version of [1, 2]) {
    const ciphertext = referenceEncrypt(testKey(version), version, SAMPLES.phone, 'users.phone');
    if (fc.decrypt(ciphertext, 'users.phone') !== SAMPLES.phone)
      problems.push(`decrypt v${version}`);
  }
  const own = fc.encrypt(SAMPLES.idNo, 'users.id_no');
  if (referenceDecrypt(testKey(CURRENT_VERSION), own, 'users.id_no') !== SAMPLES.idNo) {
    problems.push('encrypt');
  }
  if (
    fc.blindIndex(SAMPLES.phone, 'users.phone') !==
    referenceBlindIndex(testKey(BLIND_KEY_LABEL), SAMPLES.phone, 'users.phone')
  ) {
    problems.push('blindIndex');
  }
  return problems;
}

/** Opens and returns the startup error problems for `code` (empty when exactly that error). */
async function refusal(
  appEnv: AppEnvName,
  keyring: KeyringConfig,
  code: KeyringStartupErrorCode,
  secrets: Readonly<Record<string, string | Uint8Array>>,
): Promise<string[]> {
  const outcome = await settle(openConfiguredFieldCrypto(appEnv, keyring));
  if ('value' in outcome) return ['resolved instead of rejecting'];
  const problems = startupErrorProblems(outcome.error, code);
  const leaks = leaksIn(outcome.error, secrets);
  return [...problems, ...leaks.map((name) => `leaks ${name}`)];
}

it('[BR-ID-33][ADR-0001 §2] local / test / staging 用 local 提供者打开 keyring：解开全部版本，加解密与盲索引对上', async () => {
  const files = fresh('ok');
  for (const appEnv of ['local', 'test', 'staging'] as const) {
    const outcome = await settle(openConfiguredFieldCrypto(appEnv, local(files)));
    expect(
      'value' in outcome
        ? openedProblems(outcome.value)
        : [String('error' in outcome && outcome.error)],
    ).toEqual([]);
  }
});

it('[ADR-0001 §2] 主密钥文件是 64 位小写十六进制，可带且只带一个换行；keyring 文件前后可有空白、多余属性忽略', async () => {
  const hex = testKey(71).toString('hex');
  const variants = [`${hex}\n`, hex];
  for (const master of variants) {
    for (const keyring of [
      JSON.stringify(keyringDoc()),
      `\n  ${JSON.stringify(keyringDoc(), null, 2)}\n\n`,
      withNote(),
    ]) {
      const files = fresh('formats', { master, keyring });
      const outcome = await settle(openConfiguredFieldCrypto('test', local(files)));
      expect('value' in outcome ? openedProblems(outcome.value) : ['rejected']).toEqual([]);
    }
  }
});

it('[ADR-0001 §2][BR-ID-33] 主密钥文件内容不合格式时 master_key_invalid，错误确切且不泄露', async () => {
  const hex = testKey(71).toString('hex');
  const bad: Record<string, string | Uint8Array> = {
    empty: '',
    'line feed only': '\n',
    '63 characters': hex.slice(0, 63),
    '65 characters': `${hex}0`,
    'upper case': hex.toUpperCase(),
    'one upper-case letter': hex.replace(/[a-f]/, (c) => c.toUpperCase()),
    'carriage return': `${hex}\r\n`,
    'carriage return only': `${hex}\r`,
    'two line feeds': `${hex}\n\n`,
    'leading space': ` ${hex}`,
    'trailing space': `${hex} `,
    'leading line feed': `\n${hex}`,
    'non-hex letter': `${hex.slice(0, 63)}g\n`,
    '0x prefix': `0x${hex.slice(2)}`,
    'second line': `${hex}\n${hex}\n`,
    '128 characters': `${hex}${hex}`,
    'raw 32 bytes': testKey(71),
    base64: `${testKey(71).toString('base64')}\n`,
    'one mebibyte of hex': hex.repeat(16_384),
  };
  for (const [label, master] of Object.entries(bad)) {
    const files = fresh('master-bad', { master });
    expect(
      await refusal('test', local(files), 'master_key_invalid', secretsOf(files)),
      label,
    ).toEqual([]);
  }
});

it('[ADR-0001 §2] 主密钥文件打不开或不是普通文件时 master_key_unreadable，错误不带路径', async () => {
  const files = fresh('master-unreadable');
  const cases = [join(files.dir, 'no-such-master.hex'), files.dir, '/dev/null'];
  for (const masterFile of cases) {
    expect(
      await refusal(
        'test',
        { ...local(files), masterKeyFile: masterFile },
        'master_key_unreadable',
        secretsOf(files),
      ),
      masterFile,
    ).toEqual([]);
  }
});

it('[ADR-0001 §2] keyring 文件打不开或不是普通文件时 keyring_unreadable，错误不带路径', async () => {
  const files = fresh('keyring-unreadable');
  const cases = [join(files.dir, 'no-such-keyring.json'), files.dir, '/dev/null'];
  for (const keyringFile of cases) {
    expect(
      await refusal(
        'test',
        { ...local(files), keyringFile },
        'keyring_unreadable',
        secretsOf(files),
      ),
      keyringFile,
    ).toEqual([]);
  }
});

it('[BR-ID-33][ADR-0001 §2] keyring 文件不是合格 keyring 时 keyring_invalid；JSON 报错里的文件内容不外泄', async () => {
  const hex = testKey(71).toString('hex');
  const doc = keyringDoc();
  const bad: Record<string, string | Uint8Array> = {
    'not JSON, holds the master key': `master=${hex}`,
    'not JSON, holds a data key': `{"data_key": ${testKey(2).toString('hex')}}`,
    'truncated JSON': JSON.stringify(doc).slice(0, 40),
    null: 'null',
    array: JSON.stringify([doc]),
    number: '42',
    string: JSON.stringify(JSON.stringify(doc)),
    'empty object': '{}',
    empty: '',
    'no blind-index key': JSON.stringify({ ...doc, blind_index_key: undefined }),
    'current version not held': JSON.stringify({ ...doc, current_version: 3 }),
    'duplicate versions': JSON.stringify({
      ...doc,
      data_keys: [doc.data_keys[0], doc.data_keys[0]],
    }),
    'version 0': JSON.stringify({ ...doc, current_version: 0 }),
    'other key_id (wrapped with it)': JSON.stringify(keyringDoc({ keyId: 'other' })),
    'key_id LOCAL': JSON.stringify({ ...doc, key_id: 'LOCAL' }),
    'not UTF-8': notUtf8(),
    'byte order mark': `\uFEFF${JSON.stringify(doc)}`,
    'one byte over the limit': JSON.stringify(doc).padEnd(KEYRING_FILE_MAX_BYTES + 1, ' '),
  };
  for (const [label, keyring] of Object.entries(bad)) {
    const files = fresh('keyring-bad', { keyring });
    expect(await refusal('test', local(files), 'keyring_invalid', secretsOf(files)), label).toEqual(
      [],
    );
  }
});

it('[ADR-0001 §2] keyring 文件正好 1 MiB 时照常打开（上限 KEYRING_FILE_MAX_BYTES 含等号）', async () => {
  const text = JSON.stringify(keyringDoc()).padEnd(KEYRING_FILE_MAX_BYTES, ' ');
  expect(Buffer.byteLength(text)).toBe(KEYRING_FILE_MAX_BYTES);
  const files = fresh('keyring-max', { keyring: text });
  const outcome = await settle(openConfiguredFieldCrypto('test', local(files)));
  expect('value' in outcome ? openedProblems(outcome.value) : ['rejected']).toEqual([]);
});

it('[BR-ID-33] 解开的数据密钥长度不对时 keyring_invalid（openFieldCrypto 的 invalid_key 不原样外传）', async () => {
  const master = testKey(71);
  const doc = keyringDoc();
  const files = fresh('short-key', {
    keyring: JSON.stringify({
      ...doc,
      data_keys: [
        doc.data_keys[0],
        { version: 2, wrapped: referenceWrap(master, 'local', testKey(2).subarray(0, 16)) },
      ],
    }),
  });
  expect(await refusal('test', local(files), 'keyring_invalid', secretsOf(files))).toEqual([]);
});

it('[BR-ID-33][ADR-0001 §2] 主密钥不对或包裹密钥被改时 unwrap_failed，错误确切且不泄露任何密钥', async () => {
  const doc = keyringDoc();
  const first = doc.data_keys[0];
  const flipped = (() => {
    const payload = parseLk1(first?.wrapped ?? '');
    payload[20] = (payload[20] ?? 0) ^ 1;
    return `lk1.${payload.toString('base64url')}`;
  })();
  const cases: Record<string, { master?: string; keyring?: string }> = {
    'other master key': { master: masterText(OTHER_MASTER_LABEL) },
    'keyring wrapped under the other master key': {
      keyring: JSON.stringify(keyringDoc({ masterLabel: OTHER_MASTER_LABEL })),
    },
    'one data key altered': {
      keyring: JSON.stringify({
        ...doc,
        data_keys: [{ version: 1, wrapped: flipped }, doc.data_keys[1]],
      }),
    },
    'blind-index key altered': { keyring: JSON.stringify({ ...doc, blind_index_key: flipped }) },
    'wrapped key not lk1': {
      keyring: JSON.stringify({ ...doc, blind_index_key: `x${doc.blind_index_key}` }),
    },
  };
  for (const [label, contents] of Object.entries(cases)) {
    const files = fresh('unwrap', contents);
    expect(await refusal('test', local(files), 'unwrap_failed', secretsOf(files)), label).toEqual(
      [],
    );
  }
});

it('[ADR-0001 §2][规划/02 §12.6] 打开时再断言一次：APP_ENV=prod 用 local 提供者 local_in_prod，不读任何文件', async () => {
  const files = fresh('prod');
  expect(await refusal('prod', local(files), 'local_in_prod', secretsOf(files))).toEqual([]);
  const missing = {
    provider: 'local',
    keyringFile: join(files.dir, 'none.json'),
    masterKeyFile: join(files.dir, 'none.hex'),
  } as const;
  expect(await refusal('prod', missing, 'local_in_prod', secretsOf(files))).toEqual([]);
});

it('[ADR-0001 §2] kms 提供者在本任务一律 kms_unavailable，不读文件、不伪造云端调用（各 APP_ENV）', async () => {
  const files = fresh('kms');
  for (const appEnv of ['local', 'test', 'staging', 'prod'] as const) {
    for (const keyringFile of [files.keyringFile, join(files.dir, 'none.json'), files.dir]) {
      expect(
        await refusal(
          appEnv,
          { provider: 'kms', keyringFile },
          'kms_unavailable',
          secretsOf(files),
        ),
        `${appEnv} ${keyringFile}`,
      ).toEqual([]);
    }
  }
});

it('[ADR-0001 §2] 失败步骤的先后：主密钥文件先于 keyring 文件，读不到先于格式错', async () => {
  const files = fresh('order', { master: 'not hex', keyring: 'not json' });
  const noMaster = join(files.dir, 'none.hex');
  const noKeyring = join(files.dir, 'none.json');
  const cases: [KeyringConfig, KeyringStartupErrorCode][] = [
    [
      { provider: 'local', masterKeyFile: noMaster, keyringFile: noKeyring },
      'master_key_unreadable',
    ],
    [
      { provider: 'local', masterKeyFile: noMaster, keyringFile: files.keyringFile },
      'master_key_unreadable',
    ],
    [
      { provider: 'local', masterKeyFile: files.masterFile, keyringFile: noKeyring },
      'master_key_invalid',
    ],
    [
      { provider: 'local', masterKeyFile: files.masterFile, keyringFile: files.keyringFile },
      'master_key_invalid',
    ],
  ];
  for (const [keyring, code] of cases) {
    expect(await refusal('test', keyring, code, secretsOf(files)), code).toEqual([]);
  }
  const goodMaster = fresh('order-good', { keyring: 'not json' });
  expect(
    await refusal(
      'test',
      { ...local(goodMaster), keyringFile: noKeyring },
      'keyring_unreadable',
      secretsOf(goodMaster),
    ),
  ).toEqual([]);
  expect(
    await refusal('test', local(goodMaster), 'keyring_invalid', secretsOf(goodMaster)),
  ).toEqual([]);
});

it('[BR-ID-33] 打开后与文件脱钩：删掉、改写两个文件后已打开的 FieldCrypto 照常工作', async () => {
  const files = fresh('detached');
  const outcome = await settle(openConfiguredFieldCrypto('test', local(files)));
  rmSync(files.masterFile);
  writeFileSync(files.keyringFile, 'gone');
  expect('value' in outcome ? openedProblems(outcome.value) : ['rejected']).toEqual([]);
});
