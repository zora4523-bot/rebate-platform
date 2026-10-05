import { expect, it } from 'vitest';
import type {
  IdentityClaims,
  UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';
import { demo, firstItem, LinkingIdentity, online, platforms, refOf } from './kit.ts';

it.each(platforms)(
  '[AC-B1-04o-IDENTITY#1] %s 拒绝缺失、普通对象、JSON 和伪造原型的身份',
  async (platform) => {
    const port = demo(platform);
    const valid = new LinkingIdentity(platform);
    const forged: unknown = Object.assign(Object.create(Object.getPrototypeOf(valid)) as object, {
      claims: valid.claims,
    });
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      valid.claims,
      { claims: valid.claims },
      JSON.parse(JSON.stringify(valid)),
      forged,
    ];
    const req = {
      item: refOf(await firstItem(port)),
      idempotencyKey: 'identity-key',
      identity: valid,
      ...valid.claims,
    };
    for (const identity of invalid) {
      await expect(
        Promise.resolve().then(() => port.convert(req, identity as UnionIdentity, online)),
      ).rejects.toMatchObject({ code: 'invalid_identity' });
    }
    expect(await port.convert(req, valid, online)).toHaveProperty(
      'kind',
      platform === 'taobao' ? 'baichuan' : 'url',
    );
  },
);

it.each(platforms)(
  '[AC-B1-04o-IDENTITY#2] %s 服务端身份字段缺失、为空或跨 app/平台都拒绝',
  async (platform) => {
    const port = demo(platform);
    const req = { item: refOf(await firstItem(port)), idempotencyKey: 'invalid-claims' };
    const overrides: Partial<IdentityClaims>[] = [
      { appId: 'another-app' },
      { platform: platforms.find((candidate) => candidate !== platform)! },
    ];
    for (const field of [
      'appId',
      'userId',
      'platform',
      'promotionSlot',
      ...(platform === 'taobao' ? ['relationId'] : []),
    ]) {
      for (const value of [undefined, null, '', '   ']) {
        overrides.push({ [field]: value } as Partial<IdentityClaims>);
      }
    }
    for (const override of overrides) {
      const identity = new LinkingIdentity(platform, override);
      const poisonedReq = {
        ...req,
        promotionSlot: 'fallback-slot',
        relationId: 'fallback-relation',
        userId: 'fallback-user',
      };
      await expect(
        Promise.resolve().then(() => port.convert(poisonedReq, identity, online)),
      ).rejects.toMatchObject({ code: 'invalid_identity' });
    }
  },
);

it.each(platforms)(
  '[AC-B1-04o-IDENTITY#3] %s 忽略请求、商品和上下文夹带的身份，只使用独立的服务端参数',
  async (platform) => {
    const port = demo(platform);
    const item = refOf(await firstItem(port));
    const identity = new LinkingIdentity(platform);
    const req = { item, idempotencyKey: 'poisoned-request' };
    const baseline = await port.convert(req, identity, online);
    const poison = {
      appId: 'attacker-app',
      userId: 'attacker',
      promotionSlot: 'attacker-slot',
      relationId: 'attacker-relation',
    };
    const poisonedReq = {
      ...req,
      ...poison,
      identity: { claims: poison },
      item: { ...item, ...poison },
    };
    const ctx = {
      ...online,
      identity: poison,
      promotionSlot: poison.promotionSlot,
      relationId: poison.relationId,
    };
    expect(await port.convert(poisonedReq, identity, ctx)).toEqual(baseline);
    if (platform === 'taobao') {
      expect(baseline).toEqual({
        kind: 'baichuan',
        item,
        promotionSlot: 'demo-slot',
        relationId: 'demo-relation',
      });
      const second = new LinkingIdentity(platform, {
        promotionSlot: 'server-slot-b',
        relationId: 'server-relation-b',
      });
      expect(await port.convert(req, second, online)).toEqual({
        kind: 'baichuan',
        item,
        promotionSlot: 'server-slot-b',
        relationId: 'server-relation-b',
      });
    }
  },
);
