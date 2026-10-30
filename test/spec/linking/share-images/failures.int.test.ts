// B1-15z rule tests: a share that generates nothing carries no images (BR-ATTR-10 细则「淘宝分享实现」,
// 「分享页与分享赚入口页」; contract createShare). Each case first shares a product with images in the
// same tenant, so the refusal is seen against a path that does answer them; the conversion cases
// then refuse that same product, after the union detail with its images was read. The failure is
// injected at the demo adapter's convert as a union error; the 50303 case runs last, so a breaker
// it may open meets no later case of this file.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { bodyOf, expectRefused, sharesHarness } from '../shares/kit.ts';
import { expectNoImages, shareable, sharedWithImages } from './kit.ts';
import { rawUrls } from './oracle.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-15z#3] 淘宝 50301 data.reason=not_launched：同租户京东分享有图，淘宝整次不生成，响应不带 images', async () => {
  const t = await h.tenant();
  const sharer = await t.user({ taobao: 'active' });
  const { detail } = await sharedWithImages(h, sharer, 'jd');
  const [card] = shareable(await sharer.search('taobao'));
  const response = await sharer.share(bodyOf(card!));
  const body = await expectRefused(response, 503, 50301);
  expect(body.data).toMatchObject({ reason: 'not_launched', platform: 'taobao' });
  await expectNoImages(response, rawUrls(detail));
}, 120_000);

it('[AC-B1-15z#3] 京东平台拒绝转链：商品详情的图已取到，失败响应也不带 images 和任何图片地址', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const { card } = await sharedWithImages(h, sharer, 'jd');
  h.clearObservations();
  h.failConvert(new UnionError('upstream_rejected', 'synthetic conversion refused', 'jd'));
  const response = await sharer.share(bodyOf(card));
  const urls = h.items().flatMap(rawUrls);
  expect(urls.length).toBeGreaterThan(0);
  await expectNoImages(response, urls);
}, 120_000);

it('[AC-B1-15z#3] 京东临时转链失败：商品详情的图已取到，失败响应也不带 images 和任何图片地址', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const { card } = await sharedWithImages(h, sharer, 'jd');
  h.clearObservations();
  h.failConvert(new UnionError('upstream_unavailable', 'synthetic upstream unavailable', 'jd'));
  const response = await sharer.share(bodyOf(card));
  const urls = h.items().flatMap(rawUrls);
  expect(urls.length).toBeGreaterThan(0);
  await expectNoImages(response, urls);
}, 120_000);
