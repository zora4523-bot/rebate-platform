import { expect, it } from 'vitest';
import type { ItemRef } from '../../../../apps/api/src/modules/union/index.ts';
import {
  demo,
  demoLink,
  firstItem,
  keys,
  LinkingIdentity,
  online,
  platforms,
  refOf,
} from './kit.ts';

it.each(platforms)('[AC-B1-04o-OPS#1] %s 解析合成链接后可取同一商品详情', async (platform) => {
  const port = demo(platform);
  const item = await firstItem(port);
  const result = await port.resolveLink(demoLink(item), online);
  expect(keys(result)).toEqual(['item']);
  expect(result.item).toEqual(refOf(item));
  expect(await port.getItem(result.item, online)).toMatchObject(item);
  expect(await demo(platform).resolveLink(demoLink(item), online)).toEqual(result);
});

it.each(platforms)('[AC-B1-04o-OPS#2] %s 转链重复调用确定且只返回统一结果', async (platform) => {
  const port = demo(platform);
  const item = refOf(await firstItem(port));
  const identity = new LinkingIdentity(platform);
  const req = { item, idempotencyKey: 'demo-convert-1' };
  const result = await port.convert(req, identity, online);
  expect(await port.convert(req, identity, online)).toEqual(result);
  expect(await demo(platform).convert(req, identity, online)).toEqual(result);
  if (platform === 'taobao') {
    expect(result).toEqual({
      kind: 'baichuan',
      item,
      promotionSlot: 'demo-slot',
      relationId: 'demo-relation',
    });
  } else {
    expect(keys(result)).toEqual(['kind', 'url']);
    expect(result.kind).toBe('url');
    if (result.kind === 'url') {
      expect(result.url).toMatch(/^https:\/\/demo\.invalid\//);
      expect((await port.resolveLink(result.url, online)).item).toEqual(item);
    }
  }
});

it.each(platforms)('[AC-B1-04o-OPS#3] %s 渠道备案是确定性合成领域结果', async (platform) => {
  const port = demo(platform);
  const req = { authorizationCode: 'synthetic-authorization-a' };
  const result = await port.bindPublisher(req, online);
  expect(keys(result)).toEqual(['relationId']);
  expect(result.relationId).toBeTypeOf('string');
  expect(result.relationId.trim()).not.toBe('');
  expect(await port.bindPublisher(req, online)).toEqual(result);
  expect(await demo(platform).bindPublisher(req, online)).toEqual(result);
  expect(
    await port.bindPublisher({ authorizationCode: 'synthetic-authorization-b' }, online),
  ).not.toEqual(result);
});

it.each(platforms)('[AC-B1-04o-OPS#4] %s 物料游标能结束且每个商品能取详情', async (platform) => {
  const port = demo(platform);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const req = cursor === undefined ? {} : { cursor };
    const page = await port.materialFeed(req, online);
    expect(await demo(platform).materialFeed(req, online)).toEqual(page);
    for (const item of page.items) {
      const id = demoLink(item);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      expect(await port.getItem(refOf(item), online)).toMatchObject(item);
    }
    if (page.nextCursor === null) {
      cursor = undefined;
      break;
    }
    cursor = page.nextCursor;
  }
  expect(seen.size).toBeGreaterThan(0);
  expect(cursor).toBeUndefined();
});

it.each(platforms)(
  '[AC-B1-04o-OPS#5] %s 不把任意外部链接或异平台商品当作演示目录商品',
  async (platform) => {
    const port = demo(platform);
    const wrongPlatform = platforms.find((candidate) => candidate !== platform)!;
    const foreign: ItemRef = refOf(await firstItem(demo(wrongPlatform)));
    await expect(port.getItem(foreign, online)).rejects.toMatchObject({ code: 'invalid_dto' });
    await expect(port.resolveLink(demoLink(foreign), online)).rejects.toMatchObject({
      code: 'invalid_dto',
    });
    for (const raw of [
      'not-a-link',
      'https://example.invalid/not-demo',
      'https://demo.invalid.evil.invalid/jd/item',
    ]) {
      await expect(port.resolveLink(raw, online)).rejects.toMatchObject({ code: 'invalid_dto' });
    }
  },
);
