import { expect, it } from 'vitest';
import { LinkingUnionIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  type CallCtx,
  type PddAuthorityUrl,
} from '../../../../apps/api/src/modules/union/index.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ⑤): the demo adapter has pddAuthorityUrl. It answers obvious
// demo addresses (the demo host, https://demo.invalid/…), never a Pinduoduo address or payload.
const APP = 'synthetic_b1_06zf_demo';
const ATTR = 'b106zf0a';
const ctx: CallCtx = {
  appId: APP,
  requestId: '0199a3b4-5c6d-7000-8000-00000000006f',
  purpose: 'online',
};

function demo(): DemoUnionAdapter {
  return new DemoUnionAdapter({
    platform: 'pdd',
    seed: 'b1-06zf-demo',
    clock: new FixedClock('2026-11-05T02:00:00.000Z'),
    environment: 'test',
  });
}

function identity(): LinkingUnionIdentity {
  return new LinkingUnionIdentity({
    appId: APP,
    platform: 'pdd',
    promotionSlot: 'synthetic-pdd-self_buy-b1-06zf',
    userKey: ATTR,
    customParameters: { app: 'n', uid: ATTR, sc: 'self_buy' },
  });
}

/** Every link field the answer carries. */
function links(answer: PddAuthorityUrl): string[] {
  return [
    answer.url,
    answer.schema_url,
    answer.mobile_short_url,
    answer.short_url,
    answer.browser_url,
  ].filter((value): value is string => value !== undefined);
}

it('[AC-B1-06zf#21] 演示拼多多 pddAuthorityUrl 返回演示域名下的 https 地址，同时带非空且互不相同的 schema_url、mobile_short_url、url', async () => {
  const answer = await demo().pddAuthorityUrl(identity(), ctx);
  const url = new URL(answer.url);
  expect(url.protocol).toBe('https:');
  expect(url.hostname).toBe('demo.invalid');
  for (const link of links(answer)) {
    expect(link).toMatch(/\S/);
    if (/^https?:/i.test(link)) expect(new URL(link).hostname).toBe('demo.invalid');
  }
  // All three picked fields are present and distinct, so an exit taking the wrong one is visible
  // end to end ([AC-B1-06zf#1] / [#7] pin schema_url).
  const picked = [answer.schema_url, answer.mobile_short_url, answer.url];
  for (const value of picked) {
    expect(value).toEqual(expect.any(String));
    expect(String(value)).toMatch(/\S/);
  }
  expect(new Set(picked).size).toBe(3);
});

it('[AC-B1-06zf#22] 演示 pddAuthorityUrl 不仿拼多多：链接里没有拼多多域名或 App scheme，也不带内部 user_id', async () => {
  const answer = await demo().pddAuthorityUrl(identity(), ctx);
  const text = JSON.stringify(answer);
  for (const forbidden of ['yangkeduo', 'pinduoduo', 'pdd.com', 'user_id']) {
    expect(text.toLowerCase()).not.toContain(forbidden);
  }
  expect(links(answer).length).toBeGreaterThan(0);
});
