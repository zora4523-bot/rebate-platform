// B2-15k 配置（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-08 ①（收款密钥只给 API 服务的 payment 模块读，打款进程
// 读不到）、②（非 prod 只能沙箱或测试商户）；任务书 9.8：local / test 设了就拒绝启动；只有 api、worker、admin 入口读；
// prod 网关固定、设了 PAY_ALIPAY_GATEWAY 拒绝；PAY_CHANNEL_IMPL 只接受 fake、prod 设了拒绝；PAY_NOTIFY_BASE_URL 必须 https。
// 规划/11 §8「真实密钥被本地栈加载」。
import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import {
  ConfigError,
  startupViolations,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { looksLikeRealCredentialEnvName } from '../../../../apps/api/src/modules/platform/config/credential-env.ts';
import { readPayChannelsConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { EntryName } from '../../../../apps/api/src/modules/platform/entries.ts';
import {
  ALIPAY_APPID,
  APIV3_KEY,
  MERCHANT,
  OFFICIAL_GATEWAY,
  SANDBOX_GATEWAY,
  baseEnv,
  loadFor,
  prodEnv,
  stagingEnv,
  withKeyDir,
} from './kit.ts';

const CREDENTIAL_NAMES = [
  'PAY_WECHAT_APPID',
  'PAY_WECHAT_MCHID',
  'PAY_WECHAT_MERCHANT_SERIAL',
  'PAY_WECHAT_PRIVATE_KEY_FILE',
  'PAY_WECHAT_APIV3_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_ID',
  'PAY_ALIPAY_APPID',
  'PAY_ALIPAY_SELLER_ID',
  'PAY_ALIPAY_PRIVATE_KEY_FILE',
  'PAY_ALIPAY_PUBLIC_KEY_FILE',
  'PAY_ALIPAY_APP_CERT_FILE',
  'PAY_ALIPAY_PUBLIC_CERT_FILE',
  'PAY_ALIPAY_ROOT_CERT_FILE',
] as const;

function failure(env: Readonly<Record<string, string>>, entry: EntryName = 'api'): ConfigError {
  let caught: unknown;
  try {
    loadFor(env, entry);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

it.each(CREDENTIAL_NAMES)(
  '[AC-B2-15k#1401] %s 登记为真实凭据：local / test 设了就拒绝启动，错误不带值',
  (name) => {
    const value = 'FAKE_VALUE_B2_15K';
    expect(looksLikeRealCredentialEnvName(name)).toBe(true);
    for (const appEnv of ['local', 'test'] as const) {
      expect(startupViolations(appEnv, { [name]: value }).join('\n')).toContain(name);
      const error = failure({ ...baseEnv(appEnv), [name]: value });
      expect(error.problems.join('\n')).toContain(name);
      expect(inspect(error)).not.toContain(value);
    }
  },
);

it.each<EntryName>(['api', 'worker', 'admin'])(
  '[AC-B2-15k#1402] staging 的 %s 入口读收款配置；只有名字和路径，不含任何密钥',
  async (entry) => {
    await withKeyDir(async (dir) => {
      const { payChannels } = loadFor(stagingEnv(dir), entry);
      expect(payChannels).toBeTruthy();
      const text = JSON.stringify(payChannels);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(MERCHANT.privateKey);
      expect(text).not.toContain(APIV3_KEY);
      expect(text).toContain(ALIPAY_APPID);
    });
  },
);

it.each<EntryName>(['stream', 'payout'])(
  '[AC-B2-15k#1403] %s 入口永远不读收款配置（BR-PAY-08 ①）：配置里没有，写坏了也不影响启动',
  async (entry) => {
    await withKeyDir(async (dir) => {
      const env = stagingEnv(dir);
      expect(loadFor(env, 'api').payChannels).toBeTruthy();
      expect(loadFor(env, entry).payChannels ?? null).toBeNull();
      const broken = { ...env, PAY_CHANNEL_IMPL: 'not-a-choice' };
      expect(() => loadFor(broken, 'api')).toThrow(ConfigError);
      expect(loadFor(broken, entry).payChannels ?? null).toBeNull();
    });
  },
);

it.each<EntryName>(['stream', 'payout'])(
  '[AC-B2-15k#1404] prod 的 %s 入口同样不读',
  async (entry) => {
    await withKeyDir(async (dir) => {
      const env = prodEnv(dir);
      expect(loadFor(env, 'api').payChannels).toBeTruthy();
      expect(loadFor(env, entry).payChannels ?? null).toBeNull();
    });
  },
);

it.each([OFFICIAL_GATEWAY, SANDBOX_GATEWAY])(
  '[AC-B2-15k#1405] prod 设了 PAY_ALIPAY_GATEWAY=%s：拒绝启动（prod 网关固定），错误不带值',
  async (gateway) => {
    await withKeyDir(async (dir) => {
      const error = failure({ ...prodEnv(dir), PAY_ALIPAY_GATEWAY: gateway });
      expect(error.problems.join('\n')).toContain('PAY_ALIPAY_GATEWAY');
      expect(inspect(error)).not.toContain(gateway);
    });
  },
);

it('[AC-B2-15k#1406] PAY_CHANNEL_IMPL：prod 设了 fake 拒绝启动', async () => {
  await withKeyDir(async (dir) => {
    const error = failure({ ...prodEnv(dir), PAY_CHANNEL_IMPL: 'fake' });
    expect(error.problems.join('\n')).toContain('PAY_CHANNEL_IMPL');
  });
});

it.each(['real', 'FAKE', 'wechat'])(
  '[AC-B2-15k#1407] PAY_CHANNEL_IMPL=%s：只接受 fake，拒绝启动',
  async (value) => {
    await withKeyDir(async (dir) => {
      const error = failure({ ...stagingEnv(dir), PAY_CHANNEL_IMPL: value });
      expect(error.problems.join('\n')).toContain('PAY_CHANNEL_IMPL');
    });
  },
);

it('[AC-B2-15k#1408] 配置对象序列化后不暴露密钥内容（AppConfig 只有路径）', async () => {
  await withKeyDir(async (dir) => {
    const config = loadFor(stagingEnv(dir), 'api');
    expect(config.payChannels).toBeTruthy();
    expect(inspect(config, { depth: 8 })).not.toContain('PRIVATE KEY');
  });
});

it('[AC-B2-15k#1409] 缺配置不是启动错误：完整配置读得到，什么都没有或只缺一项也能加载（渠道由工厂装成不可用，任务书 9.9）', async () => {
  await withKeyDir(async (dir) => {
    const env = stagingEnv(dir);
    expect(loadFor(env, 'api').payChannels).toBeTruthy();
    expect(() => loadFor(baseEnv('staging'), 'api')).not.toThrow();
    expect(() => loadFor(baseEnv('prod'), 'api')).not.toThrow();
    const partial = { ...env };
    delete partial['PAY_WECHAT_APPID'];
    expect(() => loadFor(partial, 'api')).not.toThrow();
  });
});

it('[AC-B2-15k#1410] 配置经 config/index.ts 导出 readPayChannelsConfig，与 loadConfig 看到的一致', async () => {
  await withKeyDir(async (dir) => {
    const env = stagingEnv(dir);
    const read = readPayChannelsConfig('staging', env, 'api');
    expect(read.problems).toEqual([]);
    expect(read.payChannels).toEqual(loadFor(env, 'api').payChannels);
    expect(readPayChannelsConfig('staging', env, 'stream').payChannels).toBeNull();
  });
});
