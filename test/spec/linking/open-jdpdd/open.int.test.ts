import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createLinkOpen } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import type { LinkOpenInput } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  databaseFixture,
  fixture,
  source,
  reprice,
  attempts,
  openLogs,
  cacheKey,
} from '../open-requote/kit.ts';
import { conversionFixture, demoInput, USER_A, USER_B } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06e#34] BR-ATTR-05：他人非分享 link 新建后按打开者 attr_code 转链，重放仍是同一新 link', async () => {
  const { f, c, row, options } = await setup('jd', 'detail', USER_B);
  const service = createLinkOpen(options);
  const request = f.request(row.link_id);
  const first = await service.open(request);
  expect(first.envelope).toMatchObject({
    code: 0,
    data: { new_link_id: expect.any(String), old_final_price_fen: 2990 },
  });
  const data = first.envelope.data as { new_link_id: string };
  expect(data.new_link_id).not.toBe(row.link_id);
  expect((c.convert.mock.calls[0]![1] as JdPddIdentity).subUnionId).toBe('n_demo0002');
  expect(await service.open(request)).toEqual(first);
  expect(c.convert).toHaveBeenCalledTimes(1);
  const original = await database()
    .selectFrom('links')
    .select('user_id')
    .where('link_id', '=', row.link_id)
    .executeTakeFirstOrThrow();
  expect(original.user_id).toBe(USER_A);
});

it('[AC-B1-06e#35] BR-PRICE-08：复核佣金为零但转链成功，仍返回本次转链结果且返利为零', async () => {
  const { f, c, row, options } = await setup('pdd');
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    rebateBasis: 'no_rebate',
    estNetPriceFen: null,
  });
  const service = createLinkOpen(options);
  const result = await service.open(f.request(row.link_id));
  expect(result.envelope).toMatchObject({
    code: 0,
    data: { new_rebate_min_fen: 0, new_rebate_max_fen: 0 },
  });
  expect(c.convert).toHaveBeenCalledTimes(1);
  const converted = await c.convert.mock.results[0]!.value;
  expect(converted.kind).toBe('url');
  if (converted.kind === 'url')
    expect(JSON.stringify(result.envelope.data)).toContain(converted.url);
});

async function setup(
  platform: 'jd' | 'pdd',
  scene: 'detail' | 'share' = 'detail',
  opener: string | null = USER_A,
) {
  const f = fixture(database(), { userId: opener });
  const c = conversionFixture(platform);
  const input = await demoInput(c);
  const raw = input.owner.link.raw_item_id!;
  const item = platform === 'jd' ? { platform, itemId: raw } : { platform, goods_sign: raw };
  const row = await source(f, 2990n, item, { scene });
  // Correct identifiers are fixture setup, before any open. The immutable snapshot stays intact.
  await database()
    .updateTable('links')
    .set({ product_key: input.owner.link.product_key, raw_item_id: raw })
    .where('link_id', '=', row.link_id)
    .execute();
  if (f.state.price.kind === 'available') {
    f.state.price = {
      kind: 'available',
      input: {
        ...f.state.price.input,
        ref: {
          ...f.state.price.input.ref,
          productKey: input.owner.link.product_key!,
          rawItemId: raw,
        },
      },
    };
  }
  f.config.set(`convert.enabled.${platform}`, true);
  f.config.set('attr.click_code.jd', false);
  f.config.set('attr.click_code.pdd', false);
  const { conversion: _conversion, ...requote } = f.options;
  void _conversion;
  const options = {
    ...requote,
    registry: c.options.registry,
    logger: c.options.logger,
    attrCodes: { attrCode: c.attrCode },
  };
  return {
    f,
    c,
    row: { ...row, product_key: input.owner.link.product_key, raw_item_id: raw },
    options,
  };
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#18] %s open 完整接线：复核、转链、尝试、日志、整数金额与幂等重放',
  async (platform) => {
    const { f, c, row, options } = await setup(platform);
    const service = createLinkOpen(options);
    const request = f.request(row.link_id);
    const first = await service.open(request);
    expect(first.status).toBe(200);
    expect(first.envelope).toMatchObject({
      code: 0,
      data: {
        attempt_id: expect.any(String),
        old_final_price_fen: 2990,
        new_final_price_fen: 2990,
        new_rebate_min_fen: 229,
        new_rebate_max_fen: 229,
        new_link_id: null,
        requote_failed: false,
        jump: { expire_at: expect.any(String) },
      },
    });
    const replay = await service.open(request);
    expect(replay).toEqual(first);
    expect(c.convert).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(await attempts(database(), row.link_id)).toHaveLength(1);
    expect(await openLogs(database(), row.link_id)).toEqual([
      expect.objectContaining({ result_code: 0, user_id: USER_A }),
    ]);
    expect(f.cache.put).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_A, platform }),
      expect.objectContaining({ jump: expect.objectContaining({ expire_at: expect.any(String) }) }),
    );
  },
);

it('[AC-B1-06e#19] BR-PRICE-13：新价格与新 link 经 HTTP 用例边界返回，旧报价不覆盖', async () => {
  const { f, row, options } = await setup('jd');
  reprice(f, 3090n);
  const service = createLinkOpen(options);
  const result = await service.open(f.request(row.link_id));
  expect(result.envelope).toMatchObject({
    code: 0,
    data: {
      old_final_price_fen: 2990,
      new_final_price_fen: 3090,
      price_changed: true,
      new_link_id: expect.any(String),
    },
  });
  const stored = await database()
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', row.link_id)
    .executeTakeFirstOrThrow();
  expect(stored.quoted_final_price_fen).toBe(2990n);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#20] BR-PROD-10 %s 关闭时缓存不能绕过 50301',
  async (platform) => {
    const { f, c, row, options } = await setup(platform);
    await f.cache.put(cacheKey(row), {
      fetchedAt: f.clock.now().toISOString(),
      jump: {
        primary: { type: 'h5', value: 'https://example.test/cached' },
        fallbacks: [],
        expire_at: row.expire_at.toISOString(),
      },
    });
    f.config.set(`convert.enabled.${platform}`, false);
    const service = createLinkOpen(options);
    const result = await service.open(f.request(row.link_id));
    expect(result).toMatchObject({ status: 503, envelope: { code: 50301 } });
    expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
    expect(c.convert).not.toHaveBeenCalled();
    expect(await attempts(database(), row.link_id)).toEqual([]);
  },
);

it('[AC-B1-06e#21] BR-ATTR-06：已登录缺失 attr_code，HTTP 用例返回 50301，无 reason，并告警', async () => {
  const { f, c, row, options } = await setup('jd');
  c.attrCode.mockResolvedValue(null);
  const service = createLinkOpen(options);
  const result = await service.open(f.request(row.link_id));
  expect(result).toMatchObject({ status: 503, envelope: { code: 50301 } });
  expect(result.envelope.data ?? {}).not.toHaveProperty('reason');
  expect(c.warn).toHaveBeenCalled();
  expect(c.convert).not.toHaveBeenCalled();
});

it.each(['timeout', 'circuit_open'] as const)(
  '[AC-B1-06e#22] BR-PRICE-13：%s 不能被控制器误映射成 50301/50001',
  async (failure) => {
    const { f, c, row, options } = await setup('pdd');
    c.convert.mockRejectedValue(
      new GovernanceError(failure, 'synthetic-union', 'synthetic conversion failure'),
    );
    const service = createLinkOpen(options);
    const result = await service.open(f.request(row.link_id));
    expect(result).toMatchObject({ status: 503, envelope: { code: 50303 } });
    expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
    expect(c.convert).toHaveBeenCalledTimes(1);
    expect(await attempts(database(), row.link_id)).toEqual([]);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#23] BR-ATTR-08 %s：no_rebate 成功响应返利为零，日志记录原因，不查用户键',
  async (platform) => {
    for (const noRebateReason of [undefined, 'auth_failed'] as const) {
      const { f, c, row, options } = await setup(platform);
      c.attrCode.mockResolvedValue(null);
      const service = createLinkOpen(options);
      const request: LinkOpenInput = {
        ...f.request(row.link_id),
        noRebate: true,
        ...(noRebateReason === undefined ? {} : { noRebateReason }),
      };
      const result = await service.open(request);
      expect(result.envelope).toMatchObject({
        code: 0,
        data: {
          new_rebate_min_fen: 0,
          new_rebate_max_fen: 0,
          jump: { primary: expect.any(Object) },
        },
      });
      expect(c.attrCode).not.toHaveBeenCalled();
      expect(await openLogs(database(), row.link_id)).toEqual([
        expect.objectContaining({
          no_rebate: true,
          no_rebate_reason: noRebateReason ?? 'auth_declined',
        }),
      ]);
      const identity = c.convert.mock.calls[0]![1] as JdPddIdentity;
      expect(identity.subUnionId).toBeUndefined();
      expect(identity.custom_parameters?.uid).toBeUndefined();
    }
  },
);

it.each([null, USER_B])(
  '[AC-B1-06e#24] BR-ATTR-05：分享接线忽略打开者 %s 的 no_rebate，缓存与日志均保留分享归因',
  async (opener) => {
    const { f, c, row, options } = await setup('pdd', 'share', opener);
    const service = createLinkOpen(options);
    const result = await service.open({
      ...f.request(row.link_id),
      noRebate: true,
      noRebateReason: 'auth_failed',
    });
    expect(result.envelope).toMatchObject({ code: 0, data: { new_rebate_max_fen: 0 } });
    expect((c.convert.mock.calls[0]![1] as JdPddIdentity).custom_parameters).toEqual({
      app: 'n',
      uid: 'demo0001',
      sc: 'share',
    });
    expect(await openLogs(database(), row.link_id)).toEqual([
      expect.objectContaining({
        user_id: USER_A,
        opener_user_id: opener,
        no_rebate: false,
        no_rebate_reason: null,
      }),
    ]);
    expect(f.cache.put).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_A, noRebate: false, pidScene: 'share' }),
      expect.any(Object),
    );
  },
);

it('[AC-B1-06e#25] BR-ATTR-05：游客非分享返回 10001，不调用演示适配器', async () => {
  const { f, c, row, options } = await setup('jd', 'detail', null);
  const service = createLinkOpen(options);
  expect(await service.open(f.request(row.link_id))).toMatchObject({
    status: 401,
    envelope: { code: 10001 },
  });
  expect(c.convert).not.toHaveBeenCalled();
});

it('[AC-B1-06e#26] BR-ATTR-05：未知或其他 App 的 link 返回 30144，不转链', async () => {
  const { f, c, row, options } = await setup('jd');
  const service = createLinkOpen(options);
  expect(await service.open(f.request('0199a3b4-5c6d-7000-8000-000000000099'))).toMatchObject({
    status: 404,
    envelope: { code: 30144 },
  });
  f.current.mockResolvedValue({ appId: 'other_app', userId: USER_A, deviceId: null });
  expect(await service.open(f.request(row.link_id))).toMatchObject({
    status: 404,
    envelope: { code: 30144 },
  });
  expect(c.convert).not.toHaveBeenCalled();
});

it('[AC-B1-06e#27] BR-ATTR-27：同一用户链接缓存不能把已安装方案给未安装请求', async () => {
  const { f, row, options } = await setup('jd');
  const service = createLinkOpen(options);
  const first = await service.open({ ...f.request(row.link_id), client: 'ios', installed: 'true' });
  expect(first.envelope).toMatchObject({
    code: 0,
    data: { jump: { primary: { type: 'scheme' } } },
  });
  f.clock.advanceMs(3001);
  const second = await service.open({
    ...f.request(row.link_id),
    client: 'android',
    installed: 'false',
  });
  expect(second.envelope).toMatchObject({
    code: 0,
    data: { jump: { primary: { type: 'h5' }, fallbacks: [] } },
  });
});
