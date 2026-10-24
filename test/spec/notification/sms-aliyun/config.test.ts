// 规则测试（B1-12w；编排裁定 D10-315）：短信通道的部署配置只走四个 SMS_ 变量，经 platform 公共出口
// 的 readSmsConfig 读取；缺任一保持拒发（undefined）。local / test 一律不读，且设了其中任一即拒启动
// （规划/11 §8：本地栈不加载真实凭据，只报变量名不报值）。环境以对象参数传入，不读 process.env。
import { expect, it } from 'vitest';
import {
  ConfigError,
  SMS_CREDENTIAL_ENV_NAMES,
  findCredentialLikeEnvNames,
  loadConfig,
  readSmsConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';

const NAMES = [
  'SMS_ACCESS_KEY_ID',
  'SMS_ACCESS_KEY_SECRET',
  'SMS_SIGN_NAME',
  'SMS_TEMPLATE_VERIFY_CODE',
] as const;

const FULL: Readonly<Record<string, string | undefined>> = {
  SMS_ACCESS_KEY_ID: 'test-sms-id',
  SMS_ACCESS_KEY_SECRET: 'test-sms-sentinel-value',
  SMS_SIGN_NAME: '测试签名',
  SMS_TEMPLATE_VERIFY_CODE: 'SMS_000000001',
};

it('[AC-B1-12w#14] staging / prod：四个 SMS_ 变量都非空白 → 冻结的配置，值原样', () => {
  const results: unknown[] = [];
  for (const appEnv of ['staging', 'prod'] as const) {
    const config = readSmsConfig(appEnv, { ...FULL, APP_ENV: appEnv, SMS_UNRELATED: 'x' });
    results.push({ config, frozen: Object.isFrozen(config) });
  }
  const expected = {
    config: {
      accessKeyId: 'test-sms-id',
      accessKeySecret: 'test-sms-sentinel-value',
      signName: '测试签名',
      verifyCodeTemplate: 'SMS_000000001',
    },
    frozen: true,
  };
  expect(results).toEqual([expected, expected]);
});

it('[AC-B1-12w#15] staging / prod 缺任一（未设、空串、全空白）→ undefined，保持拒发；local / test 四个都设了也是 undefined', () => {
  const results: { readonly case: string; readonly config: unknown }[] = [];
  for (const appEnv of ['staging', 'prod'] as const) {
    for (const name of NAMES) {
      for (const value of [undefined, '', '   ']) {
        const env: Record<string, string | undefined> = { ...FULL };
        if (value === undefined) delete env[name];
        else env[name] = value;
        results.push({
          case: `${appEnv} ${name}=${JSON.stringify(value)}`,
          config: readSmsConfig(appEnv, env),
        });
      }
    }
  }
  for (const appEnv of ['local', 'test'] as const) {
    results.push({ case: `${appEnv} full`, config: readSmsConfig(appEnv, FULL) });
  }
  expect(results).toHaveLength(2 * 4 * 3 + 2);
  expect(results.filter((result) => result.config !== undefined)).toEqual([]);
  // 同一组值在 staging 完整时确实读得出（不是一律 undefined）。
  expect(readSmsConfig('staging', FULL)).toBeDefined();
});

it('[AC-B1-12w#16] SMS_CREDENTIAL_ENV_NAMES 恰为这四个名字；findCredentialLikeEnvNames 认出它们；local / test 设了任一即拒启动，只报名字不报值', () => {
  expect([...SMS_CREDENTIAL_ENV_NAMES].sort()).toEqual([...NAMES].sort());
  expect(findCredentialLikeEnvNames({ ...FULL, APP_ENV: 'test', SMS_UNRELATED: 'x' })).toEqual(
    [...NAMES].sort(),
  );
  const refusals: unknown[] = [];
  for (const appEnv of ['local', 'test']) {
    for (const name of NAMES) {
      const value = `sentinel-${appEnv}-${name.toLowerCase()}`;
      let error: unknown;
      try {
        loadConfig({ APP_ENV: appEnv, [name]: value });
      } catch (caught) {
        error = caught;
      }
      refusals.push({
        name,
        appEnv,
        configError: error instanceof ConfigError,
        named: String(error).includes(name),
        echoed: String(error).includes(value),
      });
    }
  }
  expect(refusals).toEqual(
    ['local', 'test'].flatMap((appEnv) =>
      NAMES.map((name) => ({ name, appEnv, configError: true, named: true, echoed: false })),
    ),
  );
});
