// B1-15w rule tests: a JD share whose real-time conversion fails (contract createShare, CT-15t;
// BR-ATTR-10 细则「分享页与分享赚入口页」). The platform refusing the conversion (the union answers
// upstream_rejected, e.g. no conversion permission) → 30121, not retryable; a temporary failure
// (the union dependency unavailable) → 50303. Either way nothing is generated: no link registered,
// no share_materials row. The failure is injected at the demo adapter's convert as a union error;
// the 50303 case runs last, so a breaker it may open meets no later case of this file.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { bodyOf, cardWith, expectRefused, sharesHarness } from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-15w#3] 京东平台拒绝转链（联盟 upstream_rejected）→ 30121，不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const card = cardWith(await sharer.search('jd'), true);
  const before = await h.persisted(t.appId);
  h.clearObservations();
  h.failConvert(new UnionError('upstream_rejected', 'synthetic conversion refused', 'jd'));
  await expectRefused(await sharer.share(bodyOf(card)), 422, 30121);
  // The refusal is the conversion's answer, not a check before it.
  expect(h.converts().length).toBeGreaterThan(0);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);

it('[AC-B1-15w#3] 京东临时转链失败（联盟依赖不可用）→ 50303，不登记 link、不写 share_materials', async () => {
  const t = await h.tenant();
  const sharer = await t.user();
  const card = cardWith(await sharer.search('jd'), true);
  const before = await h.persisted(t.appId);
  h.clearObservations();
  h.failConvert(new UnionError('upstream_unavailable', 'synthetic upstream unavailable', 'jd'));
  await expectRefused(await sharer.share(bodyOf(card)), 503, 50303);
  expect(h.converts().length).toBeGreaterThan(0);
  expect(await h.persisted(t.appId)).toEqual(before);
}, 120_000);
