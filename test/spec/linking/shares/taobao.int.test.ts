// B1-15w rule tests: Taobao shares (BR-ATTR-10 细则「淘宝分享实现」; contract createShare; D10-426).
// A Taobao share needs our promotion link and the token of the sharer; when either cannot be
// obtained nothing is generated: no half result, never the original link instead, no link
// registered and no share_materials row. The demo union converts Taobao only into the Baichuan
// open instruction (no promotion link, no token: the token generation permission is not granted),
// so an authorized sharer gets 50301 data.reason=not_launched, data.platform=taobao — on a retry with
// a new key as well.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bodyOf, expectRefused, sharesHarness } from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-15w#3] 淘宝取不到推广链接或口令 → 50301 data.reason=not_launched、data.platform=taobao，整次不生成：不登记 link、不写 share_materials、不给原链接', async () => {
  const t = await h.tenant();
  const sharer = await t.user({ taobao: 'active' });
  const cards = await sharer.search('taobao');
  const card = cards.find((entry) => entry.product_key !== null);
  expect(card).toBeDefined();
  const before = await h.persisted(t.appId);
  for (const key of [randomUUID(), randomUUID()]) {
    const response = await sharer.share(bodyOf(card!), { key });
    const body = await expectRefused(response, 503, 50301);
    expect(body.data).toMatchObject({ reason: 'not_launched', platform: 'taobao' });
    for (const field of ['link_id', 'share_url', 'tpwd', 'copy', 'images', 'est_promo']) {
      expect(body).not.toHaveProperty(field);
      expect(body.data ?? {}).not.toHaveProperty(field);
    }
    expect(await h.persisted(t.appId)).toEqual(before);
  }
}, 120_000);
