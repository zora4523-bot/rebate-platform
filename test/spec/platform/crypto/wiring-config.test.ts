// Rule tests: where the field-encryption keyring comes from, as validated by loadConfig at startup
// (ADR-0001 §2 鉴权与密钥「本地用文件密钥实现，云上用 KMS 实现」与「配置校验 zod，启动时校验环境变量」;
// 规划/02 §12.6「数据加密主密钥 | KMS」; 规划/11 §8「真实密钥被本地栈加载」; 规划/08 BR-ID-33). The
// contract is §1–§4 of apps/api/src/modules/platform/config/keyring.ts. Every expected problem is
// written out by hand (wiring-kit.ts PROBLEMS); a problem never quotes the value of a variable, so
// the comparisons are exact. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  APP_ENV_NAMES,
  PROBLEMS,
  configProblems,
  settleSync,
  type AppEnvName,
} from './wiring-kit.ts';

const KEYRING = '/srv/couli/keys/keyring.json';
const MASTER = '/srv/couli/keys/master.hex';

function keyringOf(env: Record<string, string>): unknown {
  const config = loadConfig(env) as unknown as Record<string, unknown>;
  return Object.hasOwn(config, 'keyring') ? config['keyring'] : 'no keyring property';
}

it('[ADR-0001 §2][规划/11 §8] local 与 test 不设 FIELD_KEY_PROVIDER 时 keyring 为 null（设为空串同未设）', () => {
  for (const appEnv of ['local', 'test'] as const) {
    expect(keyringOf({ APP_ENV: appEnv })).toBeNull();
    expect(
      keyringOf({
        APP_ENV: appEnv,
        FIELD_KEY_PROVIDER: '',
        FIELD_KEYRING_FILE: '',
        FIELD_MASTER_KEY_FILE: '',
      }),
    ).toBeNull();
  }
});

it('[ADR-0001 §2][规划/02 §12.6] staging 与 prod 不设 FIELD_KEY_PROVIDER 拒绝启动，问题文案确切（空串同未设）', () => {
  for (const appEnv of ['staging', 'prod'] as const) {
    expect(configProblems(() => loadConfig({ APP_ENV: appEnv }))).toEqual([
      PROBLEMS.providerUnset(appEnv),
    ]);
    expect(configProblems(() => loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: '' }))).toEqual([
      PROBLEMS.providerUnset(appEnv),
    ]);
  }
});

it('[ADR-0001 §2] FIELD_KEY_PROVIDER 只接受确切的 local 或 kms，取值不对时不再检查两个文件变量', () => {
  const values = ['LOCAL', 'Local', ' local', 'local ', 'kms\n', 'file', 'aliyun-kms', 'local,kms'];
  for (const appEnv of APP_ENV_NAMES) {
    for (const value of values) {
      expect(
        configProblems(() =>
          loadConfig({
            APP_ENV: appEnv,
            FIELD_KEY_PROVIDER: value,
            FIELD_KEYRING_FILE: 'relative/keyring.json',
            FIELD_MASTER_KEY_FILE: 'relative/master.hex',
          }),
        ),
        `${appEnv} ${JSON.stringify(value)}`,
      ).toEqual([PROBLEMS.providerInvalid]);
    }
  }
});

it('[ADR-0001 §2] local / test 用 local 提供者时 keyring 原样保存两个绝对路径', () => {
  const paths = [
    { keyring: KEYRING, master: MASTER },
    { keyring: '/srv/密钥 目录/../keyring.json', master: '/srv/密钥 目录/./master key.hex' },
    { keyring: '/k', master: '/m' },
  ];
  for (const appEnv of ['local', 'test'] as const) {
    for (const path of paths) {
      expect(
        keyringOf({
          APP_ENV: appEnv,
          FIELD_KEY_PROVIDER: 'local',
          FIELD_KEYRING_FILE: path.keyring,
          FIELD_MASTER_KEY_FILE: path.master,
        }),
      ).toStrictEqual({ provider: 'local', keyringFile: path.keyring, masterKeyFile: path.master });
    }
  }
});

it('[AC-B1-01zd#7][ADR-0001 §2][规划/02 §12.6] APP_ENV 为 prod 选 local 提供者拒绝启动；文件变量照常检查', () => {
  for (const appEnv of ['prod'] as const) {
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          FIELD_KEY_PROVIDER: 'local',
          FIELD_KEYRING_FILE: KEYRING,
          FIELD_MASTER_KEY_FILE: MASTER,
        }),
      ),
    ).toEqual([PROBLEMS.localInCloud(appEnv)]);
    expect(
      configProblems(() => loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'local' })),
    ).toEqual([PROBLEMS.localInCloud(appEnv), PROBLEMS.keyringUnset, PROBLEMS.masterUnset]);
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          FIELD_KEY_PROVIDER: 'local',
          FIELD_KEYRING_FILE: 'keyring.json',
          FIELD_MASTER_KEY_FILE: 'master.hex',
        }),
      ),
    ).toEqual([PROBLEMS.localInCloud(appEnv), PROBLEMS.keyringRelative, PROBLEMS.masterRelative]);
  }
});

it('[AC-B1-01zd#8][BR-ID-33] staging 选 local 且提供两个文件变量时 loadConfig 通过并保存本地提供者', () => {
  const outcome = settleSync(() =>
    loadConfig({
      APP_ENV: 'staging',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_KEYRING_FILE: KEYRING,
      FIELD_MASTER_KEY_FILE: MASTER,
    }),
  );
  expect('value' in outcome ? outcome.value.keyring : 'rejected').toStrictEqual({
    provider: 'local',
    keyringFile: KEYRING,
    masterKeyFile: MASTER,
  });
});

it('[AC-B1-01zd#9][BR-ID-33] staging 选 local 仍校验两个文件变量：必填且必须为绝对路径', () => {
  const base = { APP_ENV: 'staging', FIELD_KEY_PROVIDER: 'local' };
  expect(configProblems(() => loadConfig(base))).toEqual([
    PROBLEMS.keyringUnset,
    PROBLEMS.masterUnset,
  ]);
  expect(configProblems(() => loadConfig({ ...base, FIELD_KEYRING_FILE: KEYRING }))).toEqual([
    PROBLEMS.masterUnset,
  ]);
  expect(configProblems(() => loadConfig({ ...base, FIELD_MASTER_KEY_FILE: MASTER }))).toEqual([
    PROBLEMS.keyringUnset,
  ]);
  expect(
    configProblems(() =>
      loadConfig({
        ...base,
        FIELD_KEYRING_FILE: 'keyring.json',
        FIELD_MASTER_KEY_FILE: 'master.hex',
      }),
    ),
  ).toEqual([PROBLEMS.keyringRelative, PROBLEMS.masterRelative]);
});

it('[规划/11 §8] local 与 test 选 kms 拒绝启动（本地栈不加载真实密钥）', () => {
  for (const appEnv of ['local', 'test'] as const) {
    expect(
      configProblems(() =>
        loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: KEYRING }),
      ),
    ).toEqual([PROBLEMS.kmsInLocal(appEnv)]);
  }
});

it('[ADR-0001 §2] staging 与 prod 选 kms 时配置通过（keyring 只有 provider 与 keyringFile），不许再设主密钥文件', () => {
  for (const appEnv of ['staging', 'prod'] as const) {
    expect(
      keyringOf({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: KEYRING }),
    ).toStrictEqual({ provider: 'kms', keyringFile: KEYRING });
    expect(
      keyringOf({
        APP_ENV: appEnv,
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: KEYRING,
        FIELD_MASTER_KEY_FILE: '',
      }),
    ).toStrictEqual({ provider: 'kms', keyringFile: KEYRING });
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          FIELD_KEY_PROVIDER: 'kms',
          FIELD_KEYRING_FILE: KEYRING,
          FIELD_MASTER_KEY_FILE: MASTER,
        }),
      ),
    ).toEqual([PROBLEMS.masterWithKms]);
    expect(
      configProblems(() => loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'kms' })),
    ).toEqual([PROBLEMS.keyringUnset]);
  }
});

it('[ADR-0001 §2] 选了提供者就必须给 FIELD_KEYRING_FILE；local 还必须给 FIELD_MASTER_KEY_FILE', () => {
  for (const appEnv of ['local', 'test'] as const) {
    const base = { APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'local' };
    expect(configProblems(() => loadConfig(base))).toEqual([
      PROBLEMS.keyringUnset,
      PROBLEMS.masterUnset,
    ]);
    expect(configProblems(() => loadConfig({ ...base, FIELD_KEYRING_FILE: KEYRING }))).toEqual([
      PROBLEMS.masterUnset,
    ]);
    expect(configProblems(() => loadConfig({ ...base, FIELD_MASTER_KEY_FILE: MASTER }))).toEqual([
      PROBLEMS.keyringUnset,
    ]);
    expect(
      configProblems(() =>
        loadConfig({ ...base, FIELD_KEYRING_FILE: '', FIELD_MASTER_KEY_FILE: MASTER }),
      ),
    ).toEqual([PROBLEMS.keyringUnset]);
  }
});

it('[ADR-0001 §2] 文件变量必须是绝对路径：以 / 开头且不含控制字符', () => {
  const bad = [
    'keyring.json',
    './keyring.json',
    '../keys/keyring.json',
    '~/keyring.json',
    'C:\\keys\\keyring.json',
    ' /srv/keyring.json',
    '/srv/key\u0000ring.json',
    '/srv/key\nring.json',
    '/srv/key\rring.json',
    '/srv/key\tring.json',
    '/srv/key\u001fring.json',
    '/srv/key\u007fring.json',
  ];
  for (const appEnv of ['local', 'test'] as const) {
    for (const path of bad) {
      expect(
        configProblems(() =>
          loadConfig({
            APP_ENV: appEnv,
            FIELD_KEY_PROVIDER: 'local',
            FIELD_KEYRING_FILE: path,
            FIELD_MASTER_KEY_FILE: MASTER,
          }),
        ),
        JSON.stringify(path),
      ).toEqual([PROBLEMS.keyringRelative]);
      expect(
        configProblems(() =>
          loadConfig({
            APP_ENV: appEnv,
            FIELD_KEY_PROVIDER: 'local',
            FIELD_KEYRING_FILE: KEYRING,
            FIELD_MASTER_KEY_FILE: path,
          }),
        ),
        JSON.stringify(path),
      ).toEqual([PROBLEMS.masterRelative]);
    }
  }
  for (const appEnv of ['staging', 'prod'] as const) {
    expect(
      configProblems(() =>
        loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: 'k.json' }),
      ),
    ).toEqual([PROBLEMS.keyringRelative]);
  }
  // Characters that are not control characters are accepted as they are.
  expect(
    keyringOf({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_KEYRING_FILE: '/srv/k\u0080\u00a0e y.json',
      FIELD_MASTER_KEY_FILE: '/srv/m~$1.hex',
    }),
  ).toStrictEqual({
    provider: 'local',
    keyringFile: '/srv/k\u0080\u00a0e y.json',
    masterKeyFile: '/srv/m~$1.hex',
  });
});

it('[ADR-0001 §2] 没选提供者却设了文件变量时拒绝启动；staging 与 prod 先报提供者未设', () => {
  const files = { FIELD_KEYRING_FILE: KEYRING, FIELD_MASTER_KEY_FILE: MASTER };
  for (const appEnv of ['local', 'test'] as const) {
    expect(configProblems(() => loadConfig({ APP_ENV: appEnv, ...files }))).toEqual([
      PROBLEMS.keyringWithoutProvider,
      PROBLEMS.masterWithoutProvider,
    ]);
    expect(
      configProblems(() => loadConfig({ APP_ENV: appEnv, FIELD_MASTER_KEY_FILE: 'relative' })),
    ).toEqual([PROBLEMS.masterWithoutProvider]);
  }
  for (const appEnv of ['staging', 'prod'] as const) {
    expect(configProblems(() => loadConfig({ APP_ENV: appEnv, ...files }))).toEqual([
      PROBLEMS.providerUnset(appEnv),
      PROBLEMS.keyringWithoutProvider,
      PROBLEMS.masterWithoutProvider,
    ]);
  }
});

it('[ADR-0001 §2] keyring 的问题排在 loadConfig 其他问题之后，其他变量出错时照样检查', () => {
  expect(
    configProblems(() =>
      loadConfig({
        APP_ENV: 'prod',
        CLOCK_NOW: '2026-10-01T09:00:00+08:00',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_KEYRING_FILE: KEYRING,
        FIELD_MASTER_KEY_FILE: MASTER,
      }),
    ),
  ).toEqual([
    'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
    PROBLEMS.localInCloud('prod'),
  ]);
  const withBadLevel = configProblems(() =>
    loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'loud',
      FIELD_KEY_PROVIDER: 'kms',
      FIELD_KEYRING_FILE: KEYRING,
    }),
  );
  expect(Array.isArray(withBadLevel) ? withBadLevel.length : withBadLevel).toBe(2);
  expect(Array.isArray(withBadLevel) ? withBadLevel[0]?.startsWith('LOG_LEVEL: ') : false).toBe(
    true,
  );
  expect(Array.isArray(withBadLevel) ? withBadLevel[1] : withBadLevel).toBe(
    PROBLEMS.kmsInLocal('test'),
  );
  expect(configProblems(() => loadConfig({ APP_ENV: 'staging', API_PORT: 'eighty' }))).toEqual(
    expect.arrayContaining([PROBLEMS.providerUnset('staging')]),
  );
  const lastOf = configProblems(() => loadConfig({ APP_ENV: 'staging', API_PORT: 'eighty' }));
  expect(Array.isArray(lastOf) ? lastOf.at(-1) : lastOf).toBe(PROBLEMS.providerUnset('staging'));
});

it('[规划/02 §12.6][BR-ID-33] 问题文案与 AppConfig 都不带变量的值以外的东西：问题里没有路径', () => {
  const marker = '/srv/couli-marker-7f3a/keys';
  const cases: Record<string, string>[] = [
    {
      APP_ENV: 'prod',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_KEYRING_FILE: `${marker}/k`,
      FIELD_MASTER_KEY_FILE: `${marker}/m`,
    },
    { APP_ENV: 'test', FIELD_KEYRING_FILE: `${marker}/k`, FIELD_MASTER_KEY_FILE: `${marker}/m` },
    {
      APP_ENV: 'staging',
      FIELD_KEY_PROVIDER: 'kms',
      FIELD_KEYRING_FILE: `${marker}/k`,
      FIELD_MASTER_KEY_FILE: `${marker}/m`,
    },
  ];
  for (const env of cases) {
    const problems = configProblems(() => loadConfig(env));
    expect(Array.isArray(problems)).toBe(true);
    expect(JSON.stringify(problems)).not.toContain('couli-marker-7f3a');
  }
});

it('[AC-B1-01zd#10][ADR-0001 §2] 只读 env 参数：staging 允许 local，其他环境的取舍不变', () => {
  const table: Record<AppEnvName, Record<'unset' | 'local' | 'kms', string>> = {
    local: { unset: 'null', local: 'local', kms: 'refused' },
    test: { unset: 'null', local: 'local', kms: 'refused' },
    staging: { unset: 'refused', local: 'local', kms: 'kms' },
    prod: { unset: 'refused', local: 'refused', kms: 'kms' },
  };
  const seen: Record<string, Record<string, string>> = {};
  for (const appEnv of APP_ENV_NAMES) {
    seen[appEnv] = {};
    for (const provider of ['unset', 'local', 'kms'] as const) {
      const env: Record<string, string> = { APP_ENV: appEnv };
      if (provider !== 'unset') {
        env['FIELD_KEY_PROVIDER'] = provider;
        env['FIELD_KEYRING_FILE'] = KEYRING;
      }
      if (provider === 'local') env['FIELD_MASTER_KEY_FILE'] = MASTER;
      const outcome = configProblems(() => loadConfig(env));
      if (Array.isArray(outcome)) {
        seen[appEnv][provider] = 'refused';
      } else {
        const keyring = keyringOf(env);
        seen[appEnv][provider] =
          keyring === null
            ? 'null'
            : typeof keyring === 'object'
              ? String((keyring as { provider?: unknown }).provider)
              : String(keyring);
      }
    }
  }
  expect(seen).toEqual(table);
});
