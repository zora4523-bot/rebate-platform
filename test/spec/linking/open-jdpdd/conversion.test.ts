import { expect, it } from 'vitest';
import {
  createLinkOpenConversion,
  type JdPddIdentity,
} from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionIdentity } from '../../../../apps/api/src/modules/union/index.ts';
import { conversionFixture, conversionInput, demoInput, USER_A, USER_B } from './kit.ts';

it.each([
  ['jd', 'https://item.jd.com/12345.html'],
  ['pdd', 'https://mobile.yangkeduo.com/goods.html?goods_id=67890'],
] as const)(
  '[AC-B1-06e#36] BR-PRICE-08/13 %s：50303 内部失败结果同时给出商品键生成的无推广购买目标',
  async (platform, noRebateUrl) => {
    const f = conversionFixture(platform);
    f.convert.mockRejectedValue(
      new GovernanceError('circuit_open', 'synthetic-union', 'synthetic circuit open'),
    );
    const input = conversionInput(platform);
    const service = createLinkOpenConversion(f.options);
    await expect(service.convert(input)).rejects.toMatchObject({ code: 50303, noRebateUrl });
    expect(noRebateUrl).not.toBe(input.owner.link.promo_url);
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#33] BR-PROD-10 %s：关闭搜索不关闭转链',
  async (platform) => {
    const f = conversionFixture(platform);
    f.settings.set(`search.enabled.${platform}`, false);
    const input = await demoInput(f);
    const service = createLinkOpenConversion(f.options);
    const result = await service.convert(input);
    expect(result.primary.value).toBeTruthy();
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#1] BR-ATTR-05/06 %s：演示适配器收到服务端身份与 attr_code，不收到用户主键',
  async (platform) => {
    const f = conversionFixture(platform);
    const input = await demoInput(f);
    const service = createLinkOpenConversion(f.options);
    const result = await service.convert(input);
    expect(f.convert).toHaveBeenCalledTimes(1);
    const [request, identity, context] = f.convert.mock.calls[0]!;
    expect(identity).toBeInstanceOf(UnionIdentity);
    expect(identity.claims).toMatchObject({
      appId: 'register-app',
      platform,
      promotionSlot: 'synthetic-self_buy',
    });
    const attribution = identity as JdPddIdentity;
    if (platform === 'jd') {
      expect(attribution.subUnionId).toBe('n_demo0001');
      expect(attribution.custom_parameters).toBeUndefined();
    } else {
      expect(attribution.custom_parameters).toEqual({ app: 'n', uid: 'demo0001', sc: 'self_buy' });
      expect(attribution.subUnionId).toBeUndefined();
    }
    expect(JSON.stringify([request, attribution, context])).not.toContain(USER_A);
    expect(JSON.stringify([request, attribution, context])).not.toContain(USER_B);
    expect(f.attrCode).toHaveBeenCalledWith('register-app', USER_A);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: 'register-app',
      platform,
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    expect(request).toMatchObject({ idempotencyKey: input.idempotencyKey, item: { platform } });
    expect(result.expire_at).toBe(input.owner.link.expire_at.toISOString());
    const converted = await f.convert.mock.results[0]!.value;
    expect(converted.kind).toBe('url');
    if (converted.kind === 'url') expect(JSON.stringify(result)).toContain(converted.url);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#2] BR-ATTR-05 %s：伪造身份字段不能替换端口返回的身份',
  async (platform) => {
    const f = conversionFixture(platform);
    const input = {
      ...(await demoInput(f)),
      user_id: USER_B,
      attr_code: 'evil0001',
      pid: 'evil-pid',
      subUnionId: 'n_evil0001',
      custom_parameters: { uid: 'evil0001' },
      scene: 'share',
    };
    const service = createLinkOpenConversion(f.options);
    await service.convert(input);
    const identity = f.convert.mock.calls[0]![1] as JdPddIdentity;
    expect(JSON.stringify(identity)).not.toContain('evil');
    expect(identity.claims.promotionSlot).toBe('synthetic-self_buy');
    expect(platform === 'jd' ? identity.subUnionId : identity.custom_parameters?.uid).toBe(
      platform === 'jd' ? 'n_demo0001' : 'demo0001',
    );
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#3] BR-ATTR-08 %s：no_rebate 强制 self_buy，不查 attr_code，不带用户归因参数',
  async (platform) => {
    const f = conversionFixture(platform);
    const input = await demoInput(f);
    f.attrCode.mockRejectedValue(new Error('identity must not be queried for no_rebate'));
    const service = createLinkOpenConversion(f.options);
    const jump = await service.convert({
      ...input,
      noRebate: true,
      owner: {
        ...input.owner,
        identitySnapshot: {
          ...input.owner.identitySnapshot,
          pid_scene: 'agent',
          pid: 'synthetic-agent',
        },
      },
    });
    const identity = f.convert.mock.calls[0]![1] as JdPddIdentity;
    expect(identity.claims.promotionSlot).toBe('synthetic-self_buy');
    expect(identity.subUnionId).toBeUndefined();
    expect(identity.custom_parameters?.uid).toBeUndefined();
    expect(identity.custom_parameters?.lk).toBeUndefined();
    expect(JSON.stringify(identity)).not.toContain('demo0001');
    expect(f.attrCode).not.toHaveBeenCalled();
    expect(f.getActivePid).toHaveBeenCalledWith(
      expect.objectContaining({ pidScene: 'self_buy', purpose: 'convert' }),
    );
    expect(jump.primary.value).toBeTruthy();
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06e#4] BR-ATTR-05 %s：匿名/他人打开分享 link，no_rebate 不能剥离分享者归因',
  async (platform) => {
    for (const userId of [null, USER_B]) {
      const f = conversionFixture(platform);
      f.current.mockResolvedValue({ appId: 'register-app', userId, deviceId: null });
      const input = await demoInput(f);
      const snapshot = {
        ...input.owner.identitySnapshot,
        pid_scene: 'share',
        pid: 'synthetic-share',
      };
      const service = createLinkOpenConversion(f.options);
      await service.convert({
        ...input,
        noRebate: true,
        owner: {
          ...input.owner,
          identitySnapshot: snapshot,
          link: { ...input.owner.link, scene: 'share', pid_scene: 'share' },
        },
      });
      const identity = f.convert.mock.calls[0]![1] as JdPddIdentity;
      expect(identity.claims.promotionSlot).toBe('synthetic-share');
      expect(platform === 'jd' ? identity.subUnionId : identity.custom_parameters?.uid).toBe(
        platform === 'jd' ? 'n_demo0001' : 'demo0001',
      );
      expect(f.attrCode).toHaveBeenCalledWith('register-app', USER_A);
    }
  },
);

it.each(['missing-reader', 'null-code'] as const)(
  '[AC-B1-06e#5] BR-ATTR-06：%s 时 50301 并告警，不用 user_id 代替',
  async (mode) => {
    const f = conversionFixture();
    f.attrCode.mockResolvedValue(null);
    const { attrCodes: _reader, ...withoutReader } = f.options;
    void _reader;
    const service = createLinkOpenConversion(mode === 'missing-reader' ? withoutReader : f.options);
    await expect(service.convert(conversionInput())).rejects.toMatchObject({ code: 50301 });
    expect(f.warn).toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it.each(['none', 'pending', 'retired', 'fallback', 'query'] as const)(
  '[AC-B1-06e#6] BR-ATTR-08：%s 推广位不得转链，50301 并告警',
  async (state) => {
    const f = conversionFixture();
    if (state === 'none') f.getActivePid.mockResolvedValue(null);
    else {
      const value = await f.getActivePid({
        appId: 'register-app',
        platform: 'jd',
        pidScene: 'self_buy',
        purpose: 'convert',
      });
      f.getActivePid.mockResolvedValue({
        ...value!,
        ...(state === 'fallback' || state === 'query' ? { pid_scene: state } : { status: state }),
      });
    }
    const service = createLinkOpenConversion(f.options);
    await expect(service.convert(conversionInput())).rejects.toMatchObject({ code: 50301 });
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalled();
  },
);

it.each(['jd', 'pdd', 'taobao'] as const)(
  '[AC-B1-06e#7] BR-PROD-10：%s 关闭或淘宝尚未接入返回 50301',
  async (platform) => {
    const f = conversionFixture();
    f.settings.set(`convert.enabled.${platform}`, platform === 'taobao');
    const service = createLinkOpenConversion(f.options);
    await expect(service.convert(conversionInput(platform))).rejects.toMatchObject({ code: 50301 });
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it.each(['timeout', 'circuit_open', 'quota_exceeded', 'failure'] as const)(
  '[AC-B1-06e#8] BR-PRICE-13：%s 转链故障为 50303，不是维护码，不重发',
  async (failure) => {
    const f = conversionFixture();
    f.convert.mockRejectedValue(
      failure === 'failure'
        ? new Error('synthetic failure')
        : new GovernanceError(failure, 'synthetic-union', 'synthetic failure'),
    );
    const service = createLinkOpenConversion(f.options);
    await expect(service.convert(conversionInput())).rejects.toMatchObject({ code: 50303 });
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
);
