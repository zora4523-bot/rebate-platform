// B2-15b rule tests without a database (claude-independent, SPEC_REF 48e55e6a): 08 BR-PAY-01 ①④
// and 细则, BR-PAY-02 单号, BR-PAY-03 支付时限; task §9.2 ～ §9.6, §9.10; frozen contract CT-21c.
// Top-level it() only (规划/11 §4.3).
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createBizRegistry } from '../../../../apps/api/src/modules/payment/application/biz-registry.ts';
import type { PayCreateOrderInput } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  orderTtlMinutes,
  payOrderExpireAt,
} from '../../../../apps/api/src/modules/payment/domain/order-ttl.ts';
import {
  generateOutTradeNo,
  isValidOutTradeNo,
} from '../../../../apps/api/src/modules/payment/domain/out-trade-no.ts';
import {
  isSwitchOn,
  payUnavailableReason,
  type SaleCheckInput,
} from '../../../../apps/api/src/modules/payment/domain/sellability.ts';
import type { PayPlatform } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { FakePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { contract, endpoints, object, operation, root } from '../../contracts/pay-http/kit.ts';

const ALL: readonly PayPlatform[] = ['ios', 'android', 'harmony'];

it('[AC-B2-15b#1] 生成的 out_trade_no 为 P+20 位大写字母数字：纯 ASCII、≤32、互不相同且通过渠道交集校验', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i += 1) {
    const no = generateOutTradeNo();
    expect(no).toMatch(/^P[0-9A-Z]{20}$/);
    expect(no.length).toBeLessThanOrEqual(32);
    expect(isValidOutTradeNo(no)).toBe(true);
    seen.add(no);
  }
  expect(seen.size).toBe(5000);
});

it('[AC-B2-15b#2] 商户单号校验取两渠道交集：ASCII 字母数字 6–32 位为真，含其他字符、过短、过长为假', () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9]{6,32}$/), (value) => isValidOutTradeNo(value)),
  );
  const foreign = ['-', '_', ' ', '.', '/', '+', '=', 'é', '中', '０', 'Ａ', '\u0000', '\n'];
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9]{3,15}$/),
      fc.constantFrom(...foreign),
      fc.stringMatching(/^[A-Za-z0-9]{3,15}$/),
      (head, char, tail) => !isValidOutTradeNo(`${head}${char}${tail}`),
    ),
  );
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9]{33,80}$/), (value) => !isValidOutTradeNo(value)),
  );
  for (const value of ['', 'A', 'AB12', 'AB12C'])
    expect(isValidOutTradeNo(value), value).toBe(false);
  expect(isValidOutTradeNo('AB12CD')).toBe(true);
  expect(isValidOutTradeNo('Z'.repeat(32))).toBe(true);
  expect(isValidOutTradeNo('Z'.repeat(33))).toBe(false);
});

it('[AC-B2-15b#3] expire_at = 创建时刻 + pay.order_ttl_minutes，精确到毫秒（三个时点：日内、跨 +08 日界、跨闰日）', () => {
  const matrix = [
    ['2026-10-22T01:00:00.000Z', 15, '2026-10-22T01:15:00.000Z'],
    ['2026-10-22T15:50:00.000Z', 15, '2026-10-22T16:05:00.000Z'],
    ['2028-02-28T23:59:59.999Z', 15, '2028-02-29T00:14:59.999Z'],
    ['2026-10-22T01:00:00.000Z', 1, '2026-10-22T01:01:00.000Z'],
    ['2026-10-22T15:50:00.000Z', 60, '2026-10-22T16:50:00.000Z'],
  ] as const;
  for (const [now, minutes, expected] of matrix) {
    const created = new Date(now);
    expect(payOrderExpireAt(created, minutes).toISOString(), `${now} + ${minutes}`).toBe(expected);
    expect(created.toISOString()).toBe(now);
  }
});

it('[AC-B2-15b#4] pay.order_ttl_minutes 缺省为 15；正整数照用；其他值回默认并标记告警', () => {
  expect(orderTtlMinutes(null)).toEqual({ minutes: 15, fallback: false });
  expect(orderTtlMinutes(undefined)).toEqual({ minutes: 15, fallback: false });
  expect(orderTtlMinutes(30)).toEqual({ minutes: 30, fallback: false });
  expect(orderTtlMinutes(1)).toEqual({ minutes: 1, fallback: false });
  for (const raw of [0, -5, 1.5, '15', true, false, {}, [15]]) {
    expect(orderTtlMinutes(raw), JSON.stringify(raw)).toEqual({ minutes: 15, fallback: true });
  }
});

it('[AC-B2-15b#5] 开关只有值恰为 JSON true 才算开；缺省、false、字符串 true、1 等一律为关', () => {
  expect(isSwitchOn(true)).toBe(true);
  for (const raw of [
    null,
    undefined,
    false,
    'true',
    'TRUE',
    1,
    'on',
    {},
    [true],
    { value: true },
  ]) {
    expect(isSwitchOn(raw), JSON.stringify(raw)).toBe(false);
  }
  // BR-PAY-01 细则默认值：总开关与两个渠道开关都 off、没有登记业务类型。
  const defaults: SaleCheckInput = {
    payEnabled: null,
    channelEnabled: null,
    platform: 'android',
    registeredPlatforms: null,
    platformsOverride: null,
  };
  expect(payUnavailableReason(defaults)).toBe('pay_disabled');
  expect(payUnavailableReason({ ...defaults, payEnabled: 'true' })).toBe('pay_disabled');
  expect(payUnavailableReason({ ...defaults, payEnabled: true, channelEnabled: 1 })).toBe(
    'channel_disabled',
  );
});

it('[AC-B2-15b#6] 30901 reason 按 pay_disabled → channel_disabled → 未登记 biz_not_sellable / 端不符 platform_not_allowed 取第一个', () => {
  const pays = [true, null, false] as const;
  const registrations = [ALL, ['android', 'harmony'] as const, null] as const;
  const platforms = ['ios', 'android', 'harmony', 'h5'] as const;
  for (const payEnabled of pays) {
    for (const channelEnabled of pays) {
      for (const registeredPlatforms of registrations) {
        for (const platform of platforms) {
          const expected =
            payEnabled !== true
              ? 'pay_disabled'
              : channelEnabled !== true
                ? 'channel_disabled'
                : registeredPlatforms === null
                  ? 'biz_not_sellable'
                  : !(registeredPlatforms as readonly string[]).includes(platform)
                    ? 'platform_not_allowed'
                    : null;
          const sale: SaleCheckInput = {
            payEnabled,
            channelEnabled,
            platform,
            registeredPlatforms,
            platformsOverride: null,
          };
          expect(payUnavailableReason(sale), JSON.stringify(sale)).toBe(expected);
        }
      }
    }
  }
});

it('[AC-B2-15b#7] pay.biz.<biz_type>.platforms 覆盖登记的可售端；未登记的类型不能只靠配置变成可售', () => {
  const base: SaleCheckInput = {
    payEnabled: true,
    channelEnabled: true,
    platform: 'ios',
    registeredPlatforms: ALL,
    platformsOverride: ['android', 'harmony'],
  };
  // BR-PAY-01 细则的例：只允许安卓与鸿蒙可售，iOS 端下单 → platform_not_allowed。
  expect(payUnavailableReason(base)).toBe('platform_not_allowed');
  expect(payUnavailableReason({ ...base, platform: 'android' })).toBeNull();
  expect(payUnavailableReason({ ...base, platform: 'harmony' })).toBeNull();
  expect(payUnavailableReason({ ...base, platformsOverride: ['ios'], platform: 'android' })).toBe(
    'platform_not_allowed',
  );
  expect(payUnavailableReason({ ...base, platformsOverride: null })).toBeNull();
  expect(payUnavailableReason({ ...base, registeredPlatforms: null, platformsOverride: ALL })).toBe(
    'biz_not_sellable',
  );
});

it('[AC-B2-15b#8] 业务类型登记按 APP_ENV：prod 为空；local/test/staging 只有 test_item（1 分、测试商品、三端可售、不许用户侧退款）', async () => {
  const prod = createBizRegistry('prod');
  expect(prod.list()).toEqual([]);
  expect(prod.get('test_item')).toBeUndefined();
  for (const env of ['local', 'test', 'staging'] as const) {
    const registry = createBizRegistry(env);
    expect(
      registry.list().map((entry) => entry.code),
      env,
    ).toEqual(['test_item']);
    const entry = registry.get('test_item');
    expect(entry, env).toBeDefined();
    expect(entry!.code).toBe('test_item');
    expect([...entry!.platforms].sort()).toEqual(['android', 'harmony', 'ios']);
    expect(entry!.userRefundAllowed).toBe(false);
    expect(typeof entry!.fulfillment.reconcile).toBe('function');
    const userId = '019a0000-0000-7000-8000-0000000000a1';
    for (const bizRef of ['ref-a', 'ref-b']) {
      const price = await entry!.price({ appId: 'couli', userId, bizRef });
      expect(price).toEqual({ amountFen: 1n, title: '测试商品' });
    }
    for (const code of ['TEST_ITEM', 'test_item ', 'placeholder_biz', 'membership']) {
      expect(registry.get(code), code).toBeUndefined();
    }
  }
});

it('[AC-B2-15b#9] 队列目录登记 pay（默认重试与保留），只由 worker 入口以并发 4 处理', () => {
  const pay = QUEUE_CATALOG.filter((queue) => queue.name === 'pay');
  expect(pay).toHaveLength(1);
  expect(pay[0]).toMatchObject({
    name: 'pay',
    retryLimit: 5,
    retryDelaySeconds: 10,
    retryBackoff: true,
    retryDelayMaxSeconds: 600,
    expireInSeconds: 900,
    retentionSeconds: 1_209_600,
    deleteAfterSeconds: 604_800,
    deadLetter: 'pay.dead',
  });
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === 'pay')).toEqual([
    { queue: 'pay', concurrency: 4, pollingIntervalSeconds: 2 },
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(
      ENTRY_PLAN[entry].filter((work) => work.queue === 'pay'),
      entry,
    ).toEqual([]);
  }
});

function input(outTradeNo: string): PayCreateOrderInput {
  return {
    outTradeNo,
    amountFen: 1n,
    description: '测试商品',
    expireAt: new Date('2026-10-22T01:15:00.000Z'),
    notifyUrl: 'https://notify.invalid/pay/fixture',
  };
}

it('[AC-B2-15b#10] FakePayChannel 下单：按渠道给出契约形状的调起参数且每次不同；排队的 unknown 只作用于下一次；记录每次入参', async () => {
  const wechat = new FakePayChannel('wechat_pay');
  expect(wechat.channel).toBe('wechat_pay');
  const first = await wechat.createOrder(input('PWECHAT0000000000000001'));
  const second = await wechat.createOrder(input('PWECHAT0000000000000001'));
  expect(first).toMatchObject({ kind: 'ok', channelRef: expect.any(String) });
  expect(second).toMatchObject({ kind: 'ok', channelRef: expect.any(String) });
  const launches = [first, second].map((result) => object(object(result)['launch']));
  for (const launch of launches) {
    expect(Object.keys(launch).sort()).toEqual([
      'appid',
      'noncestr',
      'package',
      'partnerid',
      'prepayid',
      'sign',
      'timestamp',
    ]);
    for (const value of Object.values(launch)) {
      expect(typeof value).toBe('string');
      expect(String(value).length).toBeGreaterThan(0);
    }
    expect(launch['package']).toBe('Sign=WXPay');
    expect(launch['timestamp']).toMatch(/^[0-9]+$/);
  }
  expect(launches[0]).not.toEqual(launches[1]);

  const alipay = new FakePayChannel('alipay');
  expect(alipay.channel).toBe('alipay');
  const strings: unknown[] = [];
  for (let i = 0; i < 2; i += 1) {
    const result = await alipay.createOrder(input(`PALIPAY000000000000000${i}`));
    expect(result).toMatchObject({ kind: 'ok' });
    const launch = object(object(result)['launch']);
    expect(Object.keys(launch)).toEqual(['order_str']);
    expect(typeof launch['order_str']).toBe('string');
    expect(String(launch['order_str']).length).toBeGreaterThan(0);
    strings.push(launch['order_str']);
  }
  expect(strings[0]).not.toBe(strings[1]);

  wechat.scriptCreate(['unknown']);
  const unknown = await wechat.createOrder(input('PWECHAT0000000000000002'));
  expect(unknown).toMatchObject({ kind: 'unknown', reason: expect.any(String) });
  expect(unknown).not.toHaveProperty('launch');
  expect(await wechat.createOrder(input('PWECHAT0000000000000002'))).toMatchObject({ kind: 'ok' });
  expect(wechat.createCalls()).toEqual([
    input('PWECHAT0000000000000001'),
    input('PWECHAT0000000000000001'),
    input('PWECHAT0000000000000002'),
    input('PWECHAT0000000000000002'),
  ]);
  expect(alipay.createCalls()).toHaveLength(2);
});

it('[AC-B2-15b#11] FakePayChannel 查询与关单：已下单为未支付，可设为已支付 / 超时；未支付关单后为已关闭，已支付关不掉', async () => {
  const fake = new FakePayChannel('wechat_pay');
  await fake.createOrder(input('PQUERY00000000000000001'));
  expect(await fake.query('PQUERY00000000000000001')).toMatchObject({
    kind: 'ok',
    state: 'not_paid',
  });
  expect(await fake.query('PNEVERCREATED0000000001')).toMatchObject({
    kind: 'ok',
    state: 'not_exist',
  });
  fake.setTrade('PQUERY00000000000000002', 'paid');
  expect(await fake.query('PQUERY00000000000000002')).toMatchObject({ kind: 'ok', state: 'paid' });

  expect(await fake.close('PQUERY00000000000000001')).toEqual({ kind: 'ok', state: 'closed' });
  expect(await fake.query('PQUERY00000000000000001')).toMatchObject({
    kind: 'ok',
    state: 'closed',
  });
  expect(await fake.close('PQUERY00000000000000002')).not.toEqual({ kind: 'ok', state: 'closed' });
  expect(await fake.query('PQUERY00000000000000002')).toMatchObject({ kind: 'ok', state: 'paid' });

  fake.setTrade('PQUERY00000000000000003', 'timeout');
  expect(await fake.query('PQUERY00000000000000003')).toMatchObject({ kind: 'unknown' });
  expect(await fake.close('PQUERY00000000000000003')).toMatchObject({ kind: 'unknown' });
});

it('[AC-B2-15b#12] 四个用户侧支付单接口去掉 planned，进入运行时请求 schema 表', async () => {
  const doc = await contract();
  for (const [method, path, id] of endpoints) {
    const op = operation(doc, method, path);
    expect(op['operationId']).toBe(id);
    expect(op['x-implementation'], id).toBeUndefined();
  }
  const module = object(
    await import(
      new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', root).href
    ),
  );
  const schemas = object(module['CONTRACT_ROUTE_SCHEMAS']);
  for (const [, , id] of endpoints) expect(schemas, id).toHaveProperty(id);
});
