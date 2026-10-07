import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { createLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import {
  GovernanceError,
  type HandlerResult,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  attempts,
  cacheKey,
  databaseFixture,
  fixture,
  jump,
  openLogs,
  source,
} from '../open-requote/kit.ts';
import { conversionFixture, demoInput, USER_A, USER_B } from '../open-jdpdd/kit.ts';
import { pid } from '../register/kit.ts';

// B1-06p task text and task-ledger acceptance details define this change (refs is empty).
// Real ownership, catalog, conversion composition, idempotency and PG writes; only prices,
// configuration and the demo union boundary are controlled. No production platform payloads.
const database = databaseFixture(createTestDatabase);
const ROOT = new URL('../../../../', import.meta.url);

async function setup(
  platform: 'jd' | 'pdd',
  scene: 'detail' | 'share' = 'detail',
  productKey?: string,
) {
  const f = fixture(database());
  const c = conversionFixture(platform);
  const demo = await demoInput(c);
  const raw = demo.owner.link.raw_item_id!;
  const row = await source(
    f,
    2990n,
    platform === 'jd' ? { platform, itemId: raw } : { platform, goods_sign: raw },
    { scene },
  );
  const product = productKey ?? demo.owner.link.product_key!;
  // Fixture setup only: keep real demo raw IDs, with a numeric key where a page is expected.
  await database()
    .updateTable('links')
    .set({
      product_key: product,
      raw_item_id: raw,
      promo_url: 'https://example.invalid/other-promoter?pid=untrusted&uid=foreign',
    })
    .where('link_id', '=', row.link_id)
    .execute();
  f.config.set(`convert.enabled.${platform}`, true);
  f.config.set('attr.click_code.jd', false);
  f.config.set('attr.click_code.pdd', false);
  // Distinguish the active conversion slot from the frozen slot on the original link.
  c.getActivePid.mockImplementation(async (query) => ({
    ...pid(query),
    pid: `active-${query.platform}-${query.pidScene}`,
  }));
  const { conversion: unused, ...requote } = f.options;
  void unused;
  const service = createLinkOpen({
    ...requote,
    registry: c.options.registry,
    logger: c.options.logger,
    pids: { getActivePid: c.getActivePid },
    attrCodes: { attrCode: c.attrCode },
  });
  return { f, c, service, row: { ...row, product_key: product, raw_item_id: raw } };
}

function quotedLinks() {
  // Catch both inserted snapshots and mutations of any existing link, including convert_result.
  return database().selectFrom('links').selectAll().orderBy('link_id').execute();
}

async function successfulNoRebate(result: HandlerResult) {
  expect(result).toMatchObject({
    status: 200,
    envelope: {
      code: 0,
      data: {
        attempt_id: expect.any(String),
        price_changed: false,
        old_final_price_fen: 2990,
        new_final_price_fen: null,
        new_link_id: null,
        requote_failed: true,
        new_rebate_min_fen: 0,
        new_rebate_max_fen: 0,
        no_rebate_cause: null,
        quoted_at: null,
        jump: { primary: { type: 'h5', value: expect.any(String) } },
      },
    },
  });
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const validate = createValidatorCompiler()({
    schema: doc.components.schemas['OpenLinkResponse']!,
    httpPart: 'body',
  });
  expect(validate(result.envelope)).toBe(true);
  expect(validate.errors ?? []).toEqual([]);
  return result.envelope.data as components['schemas']['OpenLinkResult'];
}

function withoutUserParameters(c: ReturnType<typeof conversionFixture>, platform: 'jd' | 'pdd') {
  expect(c.convert).toHaveBeenCalledTimes(1);
  const identity = c.convert.mock.calls[0]![1] as JdPddIdentity;
  expect(identity.claims).toMatchObject({
    appId: 'register-app',
    platform,
    promotionSlot: `active-${platform}-self_buy`,
    userId: 'no_rebate',
    relationId: null,
  });
  expect(identity.subUnionId).toBeUndefined();
  expect(identity.custom_parameters?.uid).toBeUndefined();
  if (platform === 'pdd') {
    expect(identity.custom_parameters).toEqual({ app: 'n', sc: 'self_buy' });
  }
  expect(c.getActivePid).toHaveBeenCalledWith({
    appId: 'register-app',
    platform,
    pidScene: 'self_buy',
    purpose: 'convert',
  });
  expect(c.attrCode).not.toHaveBeenCalled();
}

const cases = (['jd', 'pdd'] as const).flatMap((platform) =>
  (['timeout', 'circuit_open'] as const).flatMap((failure) =>
    [1000, 3001].map((delayMs) => ({ platform, failure, delayMs })),
  ),
);

it.each(cases)(
  '[AC-B1-06p#1] $platform $failure 后 $delayMs ms 点击无返利购买：新转链、无报价写入、可幂等重放',
  async ({ platform, failure, delayMs }) => {
    // Own share link deliberately starts with a share slot, so self_buy is observable.
    const { f, c, row, service } = await setup(platform, 'share');
    f.fetch.mockRejectedValue(new GovernanceError(failure, 'synthetic-price', 'price failed'));
    const before = await quotedLinks();
    const first = await service.open(f.request(row.link_id, { client: 'h5' }));
    // Unchanged normal-purchase behavior is checked inside an otherwise red scenario.
    expect(first).toMatchObject({ status: 503, envelope: { code: 50303 } });
    expect(c.convert).not.toHaveBeenCalled();
    expect(await attempts(database(), row.link_id)).toEqual([]);
    f.clock.advanceMs(delayMs);
    // A normal-attribution cache entry must never be used as the no-rebate jump.
    const attributed = jump('normal-attribution-must-not-escape');
    await f.cache.put(cacheKey(row), {
      fetchedAt: f.clock.now().toISOString(),
      jump: attributed,
    });
    f.cache.put.mockClear();
    c.attrCode.mockClear();
    c.attrCode.mockResolvedValue(null);
    const noRebateReason = failure === 'timeout' ? undefined : 'auth_failed';
    const request = f.request(row.link_id, {
      client: 'h5',
      noRebate: true,
      ...(noRebateReason === undefined ? {} : { noRebateReason }),
    });
    const result = await service.open(request);
    const data = await successfulNoRebate(result);
    withoutUserParameters(c, platform);
    const converted = await c.convert.mock.results[0]!.value;
    expect(converted.kind).toBe('url');
    if (converted.kind === 'url') {
      expect(data.jump.primary.value).toBe(converted.url);
    }
    expect(data.jump).not.toEqual(attributed);
    expect(JSON.stringify(data.jump)).not.toMatch(/demo0001|demo0002|subUnionId|"uid"/);
    expect(await quotedLinks()).toEqual(before);
    const logs = await openLogs(database(), row.link_id);
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result_code: 50303, no_rebate: false }),
        expect.objectContaining({
          result_code: 0,
          app_id: 'register-app',
          user_id: USER_A,
          opener_user_id: USER_A,
          no_rebate: true,
          no_rebate_reason: noRebateReason ?? 'auth_declined',
        }),
      ]),
    );
    const recorded = await attempts(database(), row.link_id);
    expect(recorded).toEqual([
      expect.objectContaining({
        attempt_id: data.attempt_id,
        app_id: 'register-app',
        user_id: USER_A,
      }),
    ]);
    const fetches = f.fetch.mock.calls.length;
    expect(await service.open(request)).toEqual(result);
    expect(c.convert).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(fetches);
    expect(await openLogs(database(), row.link_id)).toEqual(logs);
    expect(await attempts(database(), row.link_id)).toEqual(recorded);
    expect(await quotedLinks()).toEqual(before);
  },
);

it.each([
  ['jd', 'jd:12345', 'https://item.jd.com/12345.html'],
  ['pdd', 'pdd:67890', 'https://mobile.yangkeduo.com/goods.html?goods_id=67890'],
] as const)(
  '[AC-B1-06p#2] %s 复核与转链均失败，返回无推广参数商品页且记录成功尝试',
  async (platform, productKey, page) => {
    const { f, c, row, service } = await setup(platform, 'detail', productKey);
    f.fetch.mockRejectedValue(new Error('synthetic price unavailable'));
    c.convert.mockRejectedValue(new GovernanceError('circuit_open', 'synthetic-union', 'failed'));
    const before = await quotedLinks();
    expect(await service.open(f.request(row.link_id))).toMatchObject({
      status: 503,
      envelope: { code: 50303 },
    });
    c.attrCode.mockClear();
    const request = f.request(row.link_id, { noRebate: true, client: 'h5' });
    const result = await service.open(request);
    const data = await successfulNoRebate(result);
    withoutUserParameters(c, platform);
    expect(data.jump).toMatchObject({ primary: { type: 'h5', value: page }, fallbacks: [] });
    expect(Date.parse(data.jump.expire_at)).toBeGreaterThan(f.clock.now().getTime());
    expect(f.cache.put).not.toHaveBeenCalled();
    expect(await quotedLinks()).toEqual(before);
    expect(await attempts(database(), row.link_id)).toEqual([
      expect.objectContaining({ attempt_id: data.attempt_id, app_id: 'register-app' }),
    ]);
    expect(await openLogs(database(), row.link_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result_code: 0,
          no_rebate: true,
          no_rebate_reason: 'auth_declined',
        }),
      ]),
    );
    expect(await service.open(request)).toEqual(result);
    expect(c.convert).toHaveBeenCalledTimes(1);
    expect(await attempts(database(), row.link_id)).toHaveLength(1);
    expect(await openLogs(database(), row.link_id)).toHaveLength(2);
  },
);

it('[AC-B1-06p#3] 京东 item 键缺 SKU：仍尝试无返利转链，失败后告警并保留 50303', async () => {
  const { f, c, row, service } = await setup('jd', 'detail', 'jd:i_SyntheticB');
  f.fetch.mockRejectedValue(new Error('synthetic price unavailable'));
  c.convert.mockRejectedValue(new Error('synthetic conversion unavailable'));
  const before = await quotedLinks();
  const result = await service.open(f.request(row.link_id, { noRebate: true, client: 'h5' }));
  expect(result).toMatchObject({ status: 503, envelope: { code: 50303 } });
  expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
  // These assertions make the old early-50303 branch red, even though its status matches.
  withoutUserParameters(c, 'jd');
  expect(c.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'linking.open.no_rebate_page_unavailable',
      app_id: 'register-app',
      platform: 'jd',
    }),
    expect.any(String),
  );
  expect(await attempts(database(), row.link_id)).toEqual([]);
  expect(await quotedLinks()).toEqual(before);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06p#4] %s 他人打开分享仍忽略 no_rebate，同窗口分享者自己点则能无返利外跳',
  async (platform) => {
    const { f, c, row, service } = await setup(platform, 'share');
    f.fetch.mockRejectedValue(new Error('synthetic price unavailable'));
    for (const opener of [USER_B, null]) {
      f.current.mockResolvedValue({
        appId: 'register-app',
        userId: opener,
        // A guest's idempotency subject is its device (platform idempotency).
        deviceId: opener === null ? '0199a3b4-5c6d-7000-8000-0000000000d1' : null,
      });
      expect(await service.open(f.request(row.link_id, { noRebate: true }))).toMatchObject({
        status: 503,
        envelope: { code: 50303 },
      });
    }
    expect(c.convert).not.toHaveBeenCalled();
    expect(await openLogs(database(), row.link_id)).toEqual([
      expect.objectContaining({
        user_id: USER_A,
        opener_user_id: USER_B,
        no_rebate: false,
        no_rebate_reason: null,
      }),
      expect.objectContaining({
        user_id: USER_A,
        opener_user_id: null,
        no_rebate: false,
        no_rebate_reason: null,
      }),
    ]);
    f.current.mockResolvedValue({ appId: 'register-app', userId: USER_A, deviceId: null });
    c.attrCode.mockClear();
    await successfulNoRebate(
      await service.open(f.request(row.link_id, { noRebate: true, client: 'h5' })),
    );
    withoutUserParameters(c, platform);
  },
);
