// Rule tests: the configuration of the second field keyring, the independent data keys of the
// isolated store of prior identities (规划/08 BR-ID-25 细则「旧身份留存」:「隔离存储用独立的数据密钥」;
// 规划/04 §3.2「实名更正旧身份」行; ADR-0001 §2 鉴权与密钥「本地用文件密钥实现，云上用 KMS 实现」与
// 「配置校验 zod，启动时校验环境变量」; 规划/11 §8「真实密钥被本地栈加载」), as validated by loadConfig.
// The contract is §1–§4 of apps/api/src/modules/platform/config/keyring-prior-identity.ts. Every
// expected problem is written out by hand (./kit.ts PRIOR_PROBLEMS); a problem never quotes the
// value of a variable, so the comparisons are exact. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig as loadConfigOf } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  APP_ENV_NAMES,
  PROBLEMS,
  configProblems,
  settleSync,
  type AppEnvName,
} from '../crypto/wiring-kit.ts';
import { PRIOR_PROBLEMS } from './kit.ts';

// B3-09j (D10-327): prod also requires AGENT_USER_HASH_KEY; every prod environment of this file
// gets a synthetic value so that only the prior identity problems remain (an explicit value wins).
// AC-B1-27e#12 only checks that no problem quotes a path and keeps calling loadConfigOf as it was.
function loadConfig(env: Record<string, string>) {
  return loadConfigOf(
    env['APP_ENV'] === 'prod'
      ? { AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-prior-identity-config', ...env }
      : env,
  );
}

const FIELD_KEYRING = '/srv/couli/keys/keyring.json';
const FIELD_MASTER = '/srv/couli/keys/master.hex';
const PRIOR_KEYRING = '/srv/couli/prior-identity/keyring.json';
const PRIOR_MASTER = '/srv/couli/prior-identity/master.hex';

const LOCAL_ENVS = ['local', 'test'] as const;
const CLOUD_ENVS = ['staging', 'prod'] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The environment around the prior identity group: local / test as they are (accepted without
 * the group), staging / prod with a kms main keyring (FIELD_* of ./keyring.ts), which loadConfig
 * accepts only together with the group (§2).
 */
function base(appEnv: AppEnvName): Record<string, string> {
  return appEnv === 'staging' || appEnv === 'prod'
    ? { APP_ENV: appEnv, FIELD_KEY_PROVIDER: 'kms', FIELD_KEYRING_FILE: FIELD_KEYRING }
    : { APP_ENV: appEnv };
}

/** The prior identity group with the local provider and the given paths. */
function local(keyringFile: string, masterKeyFile: string): Record<string, string> {
  return {
    PRIOR_IDENTITY_KEY_PROVIDER: 'local',
    PRIOR_IDENTITY_KEYRING_FILE: keyringFile,
    PRIOR_IDENTITY_MASTER_KEY_FILE: masterKeyFile,
  };
}

/**
 * `priorIdentityKeyring` of loadConfig's result: its value when it is an own property, 'absent'
 * when it is not, `{ refused: problems }` when loadConfig throws.
 */
function priorOf(env: Record<string, string>): unknown {
  const outcome = settleSync(() => loadConfig(env) as unknown as Record<string, unknown>);
  if (!('value' in outcome)) {
    return {
      refused: configProblems(() => {
        throw outcome.error;
      }),
    };
  }
  return Object.hasOwn(outcome.value, 'priorIdentityKeyring')
    ? outcome.value['priorIdentityKeyring']
    : 'absent';
}

it('[AC-B1-27e#1][BR-ID-25] local 与 test：设 local 组时 priorIdentityKeyring 原样保存两个绝对路径；不设或设为空串时结果里没有这个属性', () => {
  const paths = [
    { keyring: PRIOR_KEYRING, master: PRIOR_MASTER },
    { keyring: '/srv/旧身份 目录/../keyring.json', master: '/srv/旧身份 目录/./master key.hex' },
    { keyring: '/k', master: '/m' },
  ];
  for (const appEnv of LOCAL_ENVS) {
    expect(priorOf({ APP_ENV: appEnv }), appEnv).toBe('absent');
    expect(
      priorOf({
        APP_ENV: appEnv,
        PRIOR_IDENTITY_KEY_PROVIDER: '',
        PRIOR_IDENTITY_KEYRING_FILE: '',
        PRIOR_IDENTITY_MASTER_KEY_FILE: '',
      }),
      appEnv,
    ).toBe('absent');
    for (const path of paths) {
      expect(
        priorOf({ APP_ENV: appEnv, ...local(path.keyring, path.master) }),
        `${appEnv} ${path.keyring}`,
      ).toStrictEqual({ provider: 'local', keyringFile: path.keyring, masterKeyFile: path.master });
    }
  }
});

it('[AC-B1-27e#2][BR-ID-25][规划/02 §12.6] staging 选 local、staging 与 prod 选 kms 时 loadConfig 通过并保存这一组；staging 与 prod 不设这组（空串同未设）时拒绝启动，问题文案确切', () => {
  expect(priorOf({ ...base('staging'), ...local(PRIOR_KEYRING, PRIOR_MASTER) })).toStrictEqual({
    provider: 'local',
    keyringFile: PRIOR_KEYRING,
    masterKeyFile: PRIOR_MASTER,
  });
  for (const appEnv of CLOUD_ENVS) {
    const kms = {
      ...base(appEnv),
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
    };
    expect(priorOf(kms), appEnv).toStrictEqual({ provider: 'kms', keyringFile: PRIOR_KEYRING });
    expect(priorOf({ ...kms, PRIOR_IDENTITY_MASTER_KEY_FILE: '' }), appEnv).toStrictEqual({
      provider: 'kms',
      keyringFile: PRIOR_KEYRING,
    });
    // Unset is refused at startup like FIELD_KEY_PROVIDER (§2, ./keyring-startup.ts).
    expect(
      configProblems(() => loadConfig(base(appEnv))),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.providerUnset(appEnv)]);
    expect(
      configProblems(() =>
        loadConfig({
          ...base(appEnv),
          PRIOR_IDENTITY_KEY_PROVIDER: '',
          PRIOR_IDENTITY_KEYRING_FILE: '',
          PRIOR_IDENTITY_MASTER_KEY_FILE: '',
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.providerUnset(appEnv)]);
  }
});

it('[AC-B1-27e#3][ADR-0001 §2] PRIOR_IDENTITY_KEY_PROVIDER 只接受确切的 local 或 kms，取值不对时不再检查两个文件变量', () => {
  const values = ['LOCAL', 'Local', ' local', 'local ', 'kms\n', 'file', 'aliyun-kms', 'local,kms'];
  for (const appEnv of APP_ENV_NAMES) {
    for (const value of values) {
      expect(
        configProblems(() =>
          loadConfig({
            ...base(appEnv),
            PRIOR_IDENTITY_KEY_PROVIDER: value,
            PRIOR_IDENTITY_KEYRING_FILE: 'relative/keyring.json',
            PRIOR_IDENTITY_MASTER_KEY_FILE: 'relative/master.hex',
          }),
        ),
        `${appEnv} ${JSON.stringify(value)}`,
      ).toEqual([PRIOR_PROBLEMS.providerInvalid]);
    }
  }
});

it('[AC-B1-27e#4][ADR-0001 §2][规划/02 §12.6] APP_ENV 为 prod 选 local 拒绝启动；两个文件变量照常检查', () => {
  expect(
    configProblems(() => loadConfig({ ...base('prod'), ...local(PRIOR_KEYRING, PRIOR_MASTER) })),
  ).toEqual([PRIOR_PROBLEMS.localInCloud('prod')]);
  expect(
    configProblems(() => loadConfig({ ...base('prod'), PRIOR_IDENTITY_KEY_PROVIDER: 'local' })),
  ).toEqual([
    PRIOR_PROBLEMS.localInCloud('prod'),
    PRIOR_PROBLEMS.keyringUnset,
    PRIOR_PROBLEMS.masterUnset,
  ]);
  expect(
    configProblems(() => loadConfig({ ...base('prod'), ...local('keyring.json', 'master.hex') })),
  ).toEqual([
    PRIOR_PROBLEMS.localInCloud('prod'),
    PRIOR_PROBLEMS.keyringRelative,
    PRIOR_PROBLEMS.masterRelative,
  ]);
});

it('[AC-B1-27e#5][规划/11 §8] local 与 test 选 kms 拒绝启动（本地栈不加载真实密钥）；keyring 文件变量照常检查', () => {
  for (const appEnv of LOCAL_ENVS) {
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.kmsInLocal(appEnv)]);
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: 'keyring.json',
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.kmsInLocal(appEnv), PRIOR_PROBLEMS.keyringRelative]);
  }
});

it('[AC-B1-27e#6][ADR-0001 §2] staging 与 prod 选 kms：必须设 keyring 文件、不许设主密钥文件', () => {
  for (const appEnv of CLOUD_ENVS) {
    const kms = { ...base(appEnv), PRIOR_IDENTITY_KEY_PROVIDER: 'kms' };
    expect(
      configProblems(() => loadConfig(kms)),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringUnset]);
    expect(
      configProblems(() => loadConfig({ ...kms, PRIOR_IDENTITY_KEYRING_FILE: 'k.json' })),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringRelative]);
    expect(
      configProblems(() =>
        loadConfig({
          ...kms,
          PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
          PRIOR_IDENTITY_MASTER_KEY_FILE: PRIOR_MASTER,
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.masterWithKms]);
  }
});

it('[AC-B1-27e#7][ADR-0001 §2] 选 local 时两个文件变量都必填（空串同未设），每个变量至多一条问题', () => {
  for (const appEnv of ['local', 'test', 'staging'] as const) {
    const provider = { ...base(appEnv), PRIOR_IDENTITY_KEY_PROVIDER: 'local' };
    expect(
      configProblems(() => loadConfig(provider)),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringUnset, PRIOR_PROBLEMS.masterUnset]);
    expect(
      configProblems(() => loadConfig({ ...provider, PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING })),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.masterUnset]);
    expect(
      configProblems(() =>
        loadConfig({
          ...provider,
          PRIOR_IDENTITY_KEYRING_FILE: '',
          PRIOR_IDENTITY_MASTER_KEY_FILE: PRIOR_MASTER,
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringUnset]);
  }
});

it('[AC-B1-27e#8][ADR-0001 §2] 两个文件变量必须是绝对路径：以 / 开头且不含控制字符，其他字符原样接受', () => {
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
  for (const appEnv of LOCAL_ENVS) {
    for (const path of bad) {
      expect(
        configProblems(() => loadConfig({ APP_ENV: appEnv, ...local(path, PRIOR_MASTER) })),
        JSON.stringify(path),
      ).toEqual([PRIOR_PROBLEMS.keyringRelative]);
      expect(
        configProblems(() => loadConfig({ APP_ENV: appEnv, ...local(PRIOR_KEYRING, path) })),
        JSON.stringify(path),
      ).toEqual([PRIOR_PROBLEMS.masterRelative]);
    }
  }
  expect(
    priorOf({ APP_ENV: 'test', ...local('/srv/k\u0080\u00a0e y.json', '/srv/m~$1.hex') }),
  ).toStrictEqual({
    provider: 'local',
    keyringFile: '/srv/k\u0080\u00a0e y.json',
    masterKeyFile: '/srv/m~$1.hex',
  });
});

it('[AC-B1-27e#9][ADR-0001 §2] 没选提供者却设了文件变量时拒绝启动（各环境都一样）；staging 与 prod 先报提供者未设', () => {
  for (const appEnv of APP_ENV_NAMES) {
    const unset: string[] =
      appEnv === 'staging' || appEnv === 'prod' ? [PRIOR_PROBLEMS.providerUnset(appEnv)] : [];
    expect(
      configProblems(() =>
        loadConfig({
          ...base(appEnv),
          PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
          PRIOR_IDENTITY_MASTER_KEY_FILE: PRIOR_MASTER,
        }),
      ),
      appEnv,
    ).toEqual([
      ...unset,
      PRIOR_PROBLEMS.keyringWithoutProvider,
      PRIOR_PROBLEMS.masterWithoutProvider,
    ]);
    expect(
      configProblems(() =>
        loadConfig({ ...base(appEnv), PRIOR_IDENTITY_MASTER_KEY_FILE: 'relative' }),
      ),
      appEnv,
    ).toEqual([...unset, PRIOR_PROBLEMS.masterWithoutProvider]);
  }
});

it('[AC-B1-27e#10][BR-ID-25] 旧身份 keyring 文件与 FIELD_KEYRING_FILE 写法相同时拒绝启动；主密钥文件可以共用；写法不同的同一文件留给打开时比对', () => {
  for (const appEnv of ['local', 'test', 'staging'] as const) {
    const field = {
      APP_ENV: appEnv,
      FIELD_KEY_PROVIDER: 'local',
      FIELD_KEYRING_FILE: FIELD_KEYRING,
      FIELD_MASTER_KEY_FILE: FIELD_MASTER,
    };
    expect(
      configProblems(() => loadConfig({ ...field, ...local(FIELD_KEYRING, PRIOR_MASTER) })),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringSameAsField]);
    expect(priorOf({ ...field, ...local(PRIOR_KEYRING, FIELD_MASTER) }), appEnv).toStrictEqual({
      provider: 'local',
      keyringFile: PRIOR_KEYRING,
      masterKeyFile: FIELD_MASTER,
    });
    expect(
      priorOf({ ...field, ...local('/srv/couli/keys/./keyring.json', PRIOR_MASTER) }),
      appEnv,
    ).toStrictEqual({
      provider: 'local',
      keyringFile: '/srv/couli/keys/./keyring.json',
      masterKeyFile: PRIOR_MASTER,
    });
  }
  for (const appEnv of CLOUD_ENVS) {
    expect(
      configProblems(() =>
        loadConfig({
          ...base(appEnv),
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: FIELD_KEYRING,
        }),
      ),
      appEnv,
    ).toEqual([PRIOR_PROBLEMS.keyringSameAsField]);
  }
});

it('[AC-B1-27e#11][BR-ID-25] 两组互不影响：同时设时各自保存；旧身份的问题紧跟在 FIELD_* 的问题之后、排在其他问题之前，其他变量出错时照样检查', () => {
  const both = settleSync(
    () =>
      loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_KEYRING_FILE: FIELD_KEYRING,
        FIELD_MASTER_KEY_FILE: FIELD_MASTER,
        ...local(PRIOR_KEYRING, PRIOR_MASTER),
      }) as unknown as Record<string, unknown>,
  );
  expect(
    'value' in both
      ? { keyring: both.value['keyring'], prior: both.value['priorIdentityKeyring'] }
      : both.error,
  ).toStrictEqual({
    keyring: { provider: 'local', keyringFile: FIELD_KEYRING, masterKeyFile: FIELD_MASTER },
    prior: { provider: 'local', keyringFile: PRIOR_KEYRING, masterKeyFile: PRIOR_MASTER },
  });
  const priorOnly = settleSync(
    () =>
      loadConfig({ APP_ENV: 'local', ...local(PRIOR_KEYRING, PRIOR_MASTER) }) as unknown as Record<
        string,
        unknown
      >,
  );
  expect(
    'value' in priorOnly
      ? { keyring: priorOnly.value['keyring'], prior: priorOnly.value['priorIdentityKeyring'] }
      : priorOnly.error,
  ).toStrictEqual({
    keyring: null,
    prior: { provider: 'local', keyringFile: PRIOR_KEYRING, masterKeyFile: PRIOR_MASTER },
  });

  expect(
    configProblems(() =>
      loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'kms',
        FIELD_KEYRING_FILE: FIELD_KEYRING,
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
      }),
    ),
  ).toEqual([PROBLEMS.kmsInLocal('test'), PRIOR_PROBLEMS.kmsInLocal('test')]);
  expect(
    configProblems(() =>
      loadConfig({
        APP_ENV: 'prod',
        CLOCK_NOW: '2026-10-01T09:00:00+08:00',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_KEYRING_FILE: FIELD_KEYRING,
        FIELD_MASTER_KEY_FILE: FIELD_MASTER,
        ...local(PRIOR_KEYRING, PRIOR_MASTER),
      }),
    ),
  ).toEqual([
    'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
    PROBLEMS.localInCloud('prod'),
    PRIOR_PROBLEMS.localInCloud('prod'),
  ]);
  const beforeProxies = configProblems(() =>
    loadConfig({
      APP_ENV: 'test',
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
      TRUSTED_PROXIES: 'not-an-address',
    }),
  );
  expect(Array.isArray(beforeProxies) ? beforeProxies.length : beforeProxies).toBe(2);
  expect(Array.isArray(beforeProxies) ? beforeProxies[0] : beforeProxies).toBe(
    PRIOR_PROBLEMS.kmsInLocal('test'),
  );
  expect(
    Array.isArray(beforeProxies) ? beforeProxies[1]?.startsWith('TRUSTED_PROXIES: ') : false,
  ).toBe(true);
  const withBadLevel = configProblems(() =>
    loadConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'loud',
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
    }),
  );
  expect(Array.isArray(withBadLevel) ? withBadLevel.length : withBadLevel).toBe(2);
  expect(Array.isArray(withBadLevel) ? withBadLevel[0]?.startsWith('LOG_LEVEL: ') : false).toBe(
    true,
  );
  expect(Array.isArray(withBadLevel) ? withBadLevel[1] : withBadLevel).toBe(
    PRIOR_PROBLEMS.kmsInLocal('test'),
  );
});

it('[AC-B1-27e#12][BR-ID-25][规划/02 §12.6] 问题文案不带变量的值：问题里没有路径', () => {
  const marker = '/srv/couli-marker-b127e/keys';
  const cases: Record<string, string>[] = [
    { ...base('prod'), ...local(`${marker}/k`, `${marker}/m`) },
    {
      APP_ENV: 'test',
      PRIOR_IDENTITY_KEYRING_FILE: `${marker}/k`,
      PRIOR_IDENTITY_MASTER_KEY_FILE: `${marker}/m`,
    },
    {
      ...base('staging'),
      PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
      PRIOR_IDENTITY_KEYRING_FILE: `${marker}/k`,
      PRIOR_IDENTITY_MASTER_KEY_FILE: `${marker}/m`,
    },
    { APP_ENV: 'local', ...local('couli-marker-b127e/k', `${marker}/m`) },
  ];
  for (const env of cases) {
    const problems = configProblems(() => loadConfigOf(env));
    expect(Array.isArray(problems), JSON.stringify(problems)).toBe(true);
    expect(JSON.stringify(problems)).not.toContain('couli-marker-b127e');
  }
});

it('[AC-B1-27e#31][ADR-0001 §2] 旧身份这一组不改变主密钥环的取舍：staging 缺 FIELD_KEY_PROVIDER 时问题仍是原来那一条，配了旧身份组时它的问题排在其后', () => {
  expect(configProblems(() => loadConfig({ APP_ENV: 'staging' }))).toEqual([
    PROBLEMS.providerUnset('staging'),
  ]);
  expect(
    configProblems(() =>
      loadConfig({
        APP_ENV: 'staging',
        PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
        PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
        PRIOR_IDENTITY_MASTER_KEY_FILE: PRIOR_MASTER,
      }),
    ),
  ).toEqual([PROBLEMS.providerUnset('staging'), PRIOR_PROBLEMS.masterWithKms]);
});

it('[AC-B1-27e#32][BR-ID-25][规划/02 §12.6] staging 与 prod 设了 FIELD_KEY_PROVIDER 却缺旧身份这一组时拒绝启动：问题文案同 FIELD_* 写法，排在 FIELD_* 的问题之后', () => {
  const fieldLocal = {
    FIELD_KEY_PROVIDER: 'local',
    FIELD_KEYRING_FILE: FIELD_KEYRING,
    FIELD_MASTER_KEY_FILE: FIELD_MASTER,
  };
  expect(configProblems(() => loadConfig({ APP_ENV: 'staging', ...fieldLocal }))).toEqual([
    PRIOR_PROBLEMS.providerUnset('staging'),
  ]);
  expect(
    configProblems(() => loadConfig({ APP_ENV: 'staging', FIELD_KEY_PROVIDER: 'local' })),
  ).toEqual([PROBLEMS.keyringUnset, PROBLEMS.masterUnset, PRIOR_PROBLEMS.providerUnset('staging')]);
  expect(
    configProblems(() => loadConfig({ APP_ENV: 'staging', FIELD_KEY_PROVIDER: 'LOCAL' })),
  ).toEqual([PROBLEMS.providerInvalid, PRIOR_PROBLEMS.providerUnset('staging')]);
  expect(configProblems(() => loadConfig({ APP_ENV: 'prod', ...fieldLocal }))).toEqual([
    PROBLEMS.localInCloud('prod'),
    PRIOR_PROBLEMS.providerUnset('prod'),
  ]);
  expect(
    configProblems(() => loadConfig({ ...base('prod'), CLOCK_NOW: '2026-10-01T09:00:00+08:00' })),
  ).toEqual([
    'CLOCK_NOW: must not be set when APP_ENV=prod (the production clock is real time)',
    PRIOR_PROBLEMS.providerUnset('prod'),
  ]);
});

it('[AC-B1-27e#33][ADR-0001 §2] staging 与 prod 连 FIELD_KEY_PROVIDER 都没设时只报 FIELD 那一条、不另报旧身份提供者未设；旧身份组自己的其他问题照常排在其后', () => {
  for (const appEnv of CLOUD_ENVS) {
    expect(
      configProblems(() => loadConfig({ APP_ENV: appEnv })),
      appEnv,
    ).toEqual([PROBLEMS.providerUnset(appEnv)]);
    expect(
      configProblems(() =>
        loadConfig({ APP_ENV: appEnv, FIELD_KEY_PROVIDER: '', PRIOR_IDENTITY_KEY_PROVIDER: '' }),
      ),
      appEnv,
    ).toEqual([PROBLEMS.providerUnset(appEnv)]);
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          FIELD_KEYRING_FILE: FIELD_KEYRING,
          FIELD_MASTER_KEY_FILE: FIELD_MASTER,
        }),
      ),
      appEnv,
    ).toEqual([
      PROBLEMS.providerUnset(appEnv),
      PROBLEMS.keyringWithoutProvider,
      PROBLEMS.masterWithoutProvider,
    ]);
    expect(
      configProblems(() =>
        loadConfig({
          APP_ENV: appEnv,
          PRIOR_IDENTITY_KEYRING_FILE: PRIOR_KEYRING,
          PRIOR_IDENTITY_MASTER_KEY_FILE: PRIOR_MASTER,
        }),
      ),
      appEnv,
    ).toEqual([
      PROBLEMS.providerUnset(appEnv),
      PRIOR_PROBLEMS.keyringWithoutProvider,
      PRIOR_PROBLEMS.masterWithoutProvider,
    ]);
    expect(
      configProblems(() => loadConfig({ APP_ENV: appEnv, PRIOR_IDENTITY_KEY_PROVIDER: 'file' })),
      appEnv,
    ).toEqual([PROBLEMS.providerUnset(appEnv), PRIOR_PROBLEMS.providerInvalid]);
  }
});

it('[AC-B1-27e#13][ADR-0001 §2] 各环境的取舍表；只读 env 参数，不读 process.env', () => {
  vi.stubEnv('PRIOR_IDENTITY_KEY_PROVIDER', 'kms');
  vi.stubEnv('PRIOR_IDENTITY_KEYRING_FILE', 'relative-process-env.json');
  const table: Record<AppEnvName, Record<'unset' | 'local' | 'kms', string>> = {
    local: { unset: 'absent', local: 'local', kms: 'refused' },
    test: { unset: 'absent', local: 'local', kms: 'refused' },
    staging: { unset: 'refused', local: 'local', kms: 'kms' },
    prod: { unset: 'refused', local: 'refused', kms: 'kms' },
  };
  const seen: Record<string, Record<string, string>> = {};
  for (const appEnv of APP_ENV_NAMES) {
    const row: Record<string, string> = {};
    for (const provider of ['unset', 'local', 'kms'] as const) {
      const env = base(appEnv);
      if (provider !== 'unset') {
        env['PRIOR_IDENTITY_KEY_PROVIDER'] = provider;
        env['PRIOR_IDENTITY_KEYRING_FILE'] = PRIOR_KEYRING;
      }
      if (provider === 'local') env['PRIOR_IDENTITY_MASTER_KEY_FILE'] = PRIOR_MASTER;
      const value = priorOf(env);
      row[provider] =
        typeof value === 'string'
          ? value
          : value !== null && typeof value === 'object' && 'refused' in value
            ? 'refused'
            : String((value as { provider?: unknown } | null)?.provider);
    }
    seen[appEnv] = row;
  }
  expect(seen).toEqual(table);
});
