// B2-15k 工厂（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-08 ②（非 prod 只能沙箱或测试商户）；payment/AGENTS.md
// 第 6 条；任务书 9.1、9.8 ④⑤、9.9：任一必需项缺失或密钥读取失败，该渠道装不可用通道，不抛异常、不回退假通道、进程
// 照常启动，启动时一条 warn，只写渠道名和缺的变量名；密钥文件启动时读入内存一次。
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { FakePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import {
  AlipayPayChannel,
  UnavailablePayChannel,
  WechatPayChannel,
} from '../../../../apps/api/src/modules/payment/infra/channels/index.ts';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  ALIPAY_ORDER,
  ALIPAY_PLATFORM,
  APIV3_KEY,
  MERCHANT,
  OFFICIAL_GATEWAY,
  ORDER,
  OUT,
  QUERY_NODE,
  SANDBOX_GATEWAY,
  WECHAT_API,
  aliAnswer,
  aliTrade,
  baseEnv,
  channelSetOf,
  expectUnknown,
  loadFor,
  okOf,
  prodEnv,
  stagingEnv,
  warnLines,
  withKeyDir,
  wxAnswer,
  wxTrade,
} from './kit.ts';

const WECHAT_REQUIRED = [
  'PAY_WECHAT_APPID',
  'PAY_WECHAT_MCHID',
  'PAY_WECHAT_MERCHANT_SERIAL',
  'PAY_WECHAT_PRIVATE_KEY_FILE',
  'PAY_WECHAT_APIV3_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_ID',
  'PAY_WECHAT_TEST_MERCHANT',
] as const;

const ALIPAY_REQUIRED = [
  'PAY_ALIPAY_APPID',
  'PAY_ALIPAY_SELLER_ID',
  'PAY_ALIPAY_PRIVATE_KEY_FILE',
  'PAY_ALIPAY_PUBLIC_KEY_FILE',
  'PAY_ALIPAY_GATEWAY',
] as const;

function without(env: Record<string, string>, name: string): Record<string, string> {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

it.each(['local', 'test'] as const)(
  '[AC-B2-15k#1501] %s：两个渠道都是假通道，不读任何文件',
  async (appEnv) => {
    const { set } = await channelSetOf(loadFor(baseEnv(appEnv), 'api'));
    expect(set.of('wechat_pay')).toBeInstanceOf(FakePayChannel);
    expect(set.of('alipay')).toBeInstanceOf(FakePayChannel);
  },
);

it('[AC-B2-15k#1502] staging 设 PAY_CHANNEL_IMPL=fake：假通道', async () => {
  const { set } = await channelSetOf(
    loadFor({ ...baseEnv('staging'), PAY_CHANNEL_IMPL: 'fake' }, 'api'),
  );
  expect(set.of('wechat_pay')).toBeInstanceOf(FakePayChannel);
  expect(set.of('alipay')).toBeInstanceOf(FakePayChannel);
});

it('[AC-B2-15k#1503] staging 配置完整：真实适配器，微信走文档域名，支付宝走配置的沙箱网关', async () => {
  await withKeyDir(async (dir) => {
    const { set, calls } = await channelSetOf(loadFor(stagingEnv(dir), 'api'), (request) =>
      request.url.startsWith(WECHAT_API)
        ? wxAnswer(200, wxTrade())
        : aliAnswer(QUERY_NODE, aliTrade()),
    );
    const wechat = set.of('wechat_pay');
    const alipay = set.of('alipay');
    expect(wechat).toBeInstanceOf(WechatPayChannel);
    expect(alipay).toBeInstanceOf(AlipayPayChannel);
    okOf(await wechat.query(OUT));
    okOf(await alipay.query(OUT));
    expect(calls[0]!.url.startsWith(`${WECHAT_API}/`)).toBe(true);
    expect(calls[1]!.url.startsWith(SANDBOX_GATEWAY)).toBe(true);
  });
});

it('[AC-B2-15k#1504] prod 配置完整：支付宝走文档官方网关，不要求测试商户开关', async () => {
  await withKeyDir(async (dir) => {
    const { set, calls } = await channelSetOf(loadFor(prodEnv(dir), 'api'), (request) =>
      request.url.startsWith(WECHAT_API)
        ? wxAnswer(200, wxTrade())
        : aliAnswer(QUERY_NODE, aliTrade()),
    );
    expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
    expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
    okOf(await set.of('alipay').query(OUT));
    expect(calls[0]!.url.startsWith(OFFICIAL_GATEWAY)).toBe(true);
  });
});

it.each(WECHAT_REQUIRED)(
  '[AC-B2-15k#1505] staging 缺 %s：微信不可用，支付宝不受影响；不抛异常，一条 warn 只写渠道名和变量名',
  async (name) => {
    await withKeyDir(async (dir) => {
      const env = without(stagingEnv(dir), name);
      const { set, logs } = await channelSetOf(loadFor(env, 'api'));
      expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
      expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
      const warns = warnLines(logs);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(name);
      expect(warns[0]).toContain('wechat');
      expect(warns[0]).not.toContain(dir);
      expect(await set.of('wechat_pay').createOrder(ORDER)).toEqual({
        kind: 'unknown',
        reason: 'channel_unconfigured',
      });
    });
  },
);

it.each(ALIPAY_REQUIRED)(
  '[AC-B2-15k#1506] staging 缺 %s：支付宝不可用，微信不受影响；不抛异常，一条 warn 只写渠道名和变量名',
  async (name) => {
    await withKeyDir(async (dir) => {
      const env = without(stagingEnv(dir), name);
      const { set, logs } = await channelSetOf(loadFor(env, 'api'));
      expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
      expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
      const warns = warnLines(logs);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(name);
      expect(warns[0]).toContain('alipay');
      expect(warns[0]).not.toContain(dir);
      expect(await set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual({
        kind: 'unknown',
        reason: 'channel_unconfigured',
      });
    });
  },
);

it.each(['PAY_APP_ID', 'PAY_NOTIFY_BASE_URL'])(
  '[AC-B2-15k#1507] 缺 %s：两个渠道都不可用，不抛异常',
  async (name) => {
    await withKeyDir(async (dir) => {
      const { set, logs } = await channelSetOf(loadFor(without(stagingEnv(dir), name), 'api'));
      expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
      expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
      expect(warnLines(logs).join('\n')).toContain(name);
    });
  },
);

it('[AC-B2-15k#1508] staging 什么都没配：两个渠道都不可用，不回退假通道', async () => {
  const { set } = await channelSetOf(loadFor(baseEnv('staging'), 'api'));
  expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
  expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
});

it('[AC-B2-15k#1509] prod 什么都没配：两个渠道都不可用；下单得 unknown（调用方映射 50306），通知 rejected', async () => {
  const { set } = await channelSetOf(loadFor(baseEnv('prod'), 'api'));
  expectUnknown(await set.of('wechat_pay').createOrder(ORDER));
  expectUnknown(await set.of('alipay').createOrder(ALIPAY_ORDER));
  expect((await set.of('alipay').verifyNotification({ headers: {}, body: '' })).kind).toBe(
    'rejected',
  );
});

const NOT_SANDBOX: [string, Record<string, string>, PayChannelCode][] = [
  ['PAY_WECHAT_TEST_MERCHANT=0', { PAY_WECHAT_TEST_MERCHANT: '0' }, 'wechat_pay'],
  ['PAY_WECHAT_TEST_MERCHANT=true', { PAY_WECHAT_TEST_MERCHANT: 'true' }, 'wechat_pay'],
  ['网关等于生产网关', { PAY_ALIPAY_GATEWAY: OFFICIAL_GATEWAY }, 'alipay'],
  ['生产网关带尾斜线', { PAY_ALIPAY_GATEWAY: `${OFFICIAL_GATEWAY}/` }, 'alipay'],
  ['生产网关大写主机名', { PAY_ALIPAY_GATEWAY: 'https://OPENAPI.ALIPAY.COM/gateway.do' }, 'alipay'],
  [
    '生产网关带默认端口',
    { PAY_ALIPAY_GATEWAY: 'https://openapi.alipay.com:443/gateway.do' },
    'alipay',
  ],
  ['生产网关带查询串', { PAY_ALIPAY_GATEWAY: `${OFFICIAL_GATEWAY}?charset=utf-8` }, 'alipay'],
  ['网关不是地址', { PAY_ALIPAY_GATEWAY: 'not a url' }, 'alipay'],
];

it.each(NOT_SANDBOX)(
  '[AC-B2-15k#1510] 非 prod 不是沙箱或测试商户（%s）：该渠道不可用（BR-PAY-08 ②）',
  async (_name, overrides, code) => {
    await withKeyDir(async (dir) => {
      let unavailable: boolean;
      try {
        const { set } = await channelSetOf(loadFor({ ...stagingEnv(dir), ...overrides }, 'api'));
        unavailable = set.of(code) instanceof UnavailablePayChannel;
      } catch (error) {
        // 只有 loadConfig 明确拒绝启动也算守住；骨架的 NotImplemented 不算。
        expect(String(error)).toContain('Invalid environment configuration');
        unavailable = true;
      }
      expect(unavailable).toBe(true);
    });
  },
);

it.each([
  ['http 的通知基址', 'http://pay.example.test'],
  ['不是地址', 'not a url'],
])(
  '[AC-B2-15k#1511] PAY_NOTIFY_BASE_URL 不合格（%s）：拒绝启动或两个渠道都不可用，绝不带着它下单',
  async (_name, value) => {
    await withKeyDir(async (dir) => {
      // 好配置必须能装出真实适配器，才谈得上「坏配置装不出」。
      const good = await channelSetOf(loadFor(stagingEnv(dir), 'api'));
      expect(good.set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
      let refused = false;
      let config: AppConfig | undefined;
      try {
        config = loadFor({ ...stagingEnv(dir), PAY_NOTIFY_BASE_URL: value }, 'api');
      } catch {
        refused = true;
      }
      if (config === undefined) {
        expect(refused).toBe(true);
      } else {
        const { set } = await channelSetOf(config);
        expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
        expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
      }
    });
  },
);

const WECHAT_KEY_FILES = [
  ['商户私钥', 'wechat-private.pem'],
  ['微信支付公钥', 'wechat-public.pem'],
  ['APIv3 密钥（文档要求 32 字节）', 'wechat-apiv3.key'],
] as const;

it.each(WECHAT_KEY_FILES)(
  '[AC-B2-15k#1512] %s内容不合格：微信不可用，日志不带路径和内容，不抛异常',
  async (_name, file) => {
    await withKeyDir(async (dir) => {
      await writeFile(join(dir, file), 'not-a-valid-secret');
      const { set, logs } = await channelSetOf(loadFor(stagingEnv(dir), 'api'));
      expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
      expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
      const text = logs.join('\n');
      expect(text).not.toContain(dir);
      expect(text).not.toContain('not-a-valid-secret');
    });
  },
);

const ALIPAY_KEY_FILES = [
  ['应用私钥', 'alipay-private.pem'],
  ['支付宝公钥', 'alipay-public.pem'],
] as const;

it.each(ALIPAY_KEY_FILES)(
  '[AC-B2-15k#1513] %s内容不合格：支付宝不可用，日志不带路径和内容，不抛异常',
  async (_name, file) => {
    await withKeyDir(async (dir) => {
      await writeFile(join(dir, file), 'not-a-valid-secret');
      const { set, logs } = await channelSetOf(loadFor(stagingEnv(dir), 'api'));
      expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
      expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
      const text = logs.join('\n');
      expect(text).not.toContain(dir);
      expect(text).not.toContain('not-a-valid-secret');
    });
  },
);

it('[AC-B2-15k#1514] 密钥文件不存在：该渠道不可用，warn 写变量名不写路径，不抛异常', async () => {
  await withKeyDir(async (dir) => {
    await rm(join(dir, 'wechat-private.pem'));
    const { set, logs } = await channelSetOf(loadFor(stagingEnv(dir), 'api'));
    expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
    const text = warnLines(logs).join('\n');
    expect(text).toContain('PAY_WECHAT_PRIVATE_KEY_FILE');
    expect(text).not.toContain(dir);
  });
});

it('[AC-B2-15k#1515] 密钥启动时读入内存一次：之后删除文件，通道照常签名；配置完整时没有 warn', async () => {
  await withKeyDir(async (dir) => {
    const { set, logs } = await channelSetOf(loadFor(stagingEnv(dir), 'api'), () =>
      wxAnswer(200, { prepay_id: 'wx-prepay-1' }),
    );
    expect(warnLines(logs)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
    okOf(await set.of('wechat_pay').createOrder(ORDER));
    okOf(await set.of('alipay').createOrder(ALIPAY_ORDER));
  });
});

it('[AC-B2-15k#1516] 启动日志不含任何密钥内容', async () => {
  await withKeyDir(async (dir) => {
    const { logs } = await channelSetOf(loadFor(stagingEnv(dir), 'api'));
    const text = logs.join('\n');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(MERCHANT.privateKey);
    expect(text).not.toContain(ALIPAY_PLATFORM.publicKey);
    expect(text).not.toContain(APIV3_KEY);
  });
});
