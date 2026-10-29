// B1-15u: POST /v1/share-pages/{link_id}/tpwd through the real api entry (BR-ATTR-10 细则「中间页的
// 口令按打开环境区分」: ticket bound to link_id, 600 s, at most 3 exchanges; WeChat or no UA → 20001;
// per IP × link_id share.tpwd_rate_per_min, default 5 → 42901 with Retry-After; no-store).
// Tickets are fetched with GET from their own address, so only exchanges count in the buckets.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DEFAULT_RATE,
  MISSING,
  NOW,
  RATE_KEY,
  TICKET_TTL_MS,
  TICKET_USES,
  UA,
  WECHAT_LIKE,
  expectRateLimited,
  expectTicketRefused,
  pageData,
  shareHarness,
  tampered,
  ticketOf,
  tpwdOf,
  type ShareLink,
  type Tenant,
} from './kit.ts';

const h = shareHarness();

/** The page as a system browser opens it; GETs never share an address with the exchanges. */
async function ticketFor(t: Tenant, link: ShareLink): Promise<string> {
  return ticketOf(await pageData(await h.get(t.appId, link.linkId, { ip: '192.0.2.200' })));
}

async function taobaoShare(t: Tenant): Promise<ShareLink> {
  return t.link(await t.sharer({ taobao: 'active' }), 'taobao');
}

it('[AC-B1-15u#6] 有效票据换回口令；票据绑定 link_id：换别的 link、不存在的 link、别的 App 都是 20001', async () => {
  const t = await h.tenant();
  const other = await h.tenant();
  const first = await taobaoShare(t);
  const second = await taobaoShare(t);
  const ticket = await ticketFor(t, first);
  // Anonymous, unsigned, no X-Device-Id (the kit sends none).
  expect(await tpwdOf(await h.tpwd(t.appId, first.linkId, ticket, { ip: '203.0.113.11' }))).toBe(
    first.tpwd,
  );
  await expectTicketRefused(
    await h.tpwd(t.appId, second.linkId, ticket, { ip: '203.0.113.12' }),
    first.tpwdCore,
    second.tpwdCore,
  );
  await expectTicketRefused(
    await h.tpwd(t.appId, MISSING, ticket, { ip: '203.0.113.13' }),
    first.tpwdCore,
  );
  await expectTicketRefused(
    await h.tpwd(other.appId, first.linkId, ticket, { ip: '203.0.113.14' }),
    first.tpwdCore,
  );
  // The second link answers its own ticket with its own token.
  const own = await ticketFor(t, second);
  expect(await tpwdOf(await h.tpwd(t.appId, second.linkId, own, { ip: '203.0.113.15' }))).toBe(
    second.tpwd,
  );
}, 60_000);

it('[AC-B1-15u#6] 票据 600 秒有效：599 秒时仍可换，过期后 20001 且不返回口令（注入时钟）', async () => {
  const t = await h.tenant();
  const link = await taobaoShare(t);
  const ticket = await ticketFor(t, link);
  h.clock.advanceMs(TICKET_TTL_MS - 1_000);
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, ticket, { ip: '203.0.113.21' }))).toBe(
    link.tpwd,
  );
  h.clock.set(new Date(Date.parse(NOW) + TICKET_TTL_MS + 1_000));
  await expectTicketRefused(
    await h.tpwd(t.appId, link.linkId, ticket, { ip: '203.0.113.22' }),
    link.tpwdCore,
  );
  // A ticket issued now is valid again.
  const fresh = await ticketFor(t, link);
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, fresh, { ip: '203.0.113.23' }))).toBe(
    link.tpwd,
  );
}, 60_000);

it('[AC-B1-15u#6] 一张票据最多换 3 次：第 4 次 20001；新票据照常可换', async () => {
  const t = await h.tenant();
  const link = await taobaoShare(t);
  const ticket = await ticketFor(t, link);
  for (let use = 0; use < TICKET_USES; use++) {
    expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, ticket, { ip: '203.0.113.31' }))).toBe(
      link.tpwd,
    );
  }
  await expectTicketRefused(
    await h.tpwd(t.appId, link.linkId, ticket, { ip: '203.0.113.31' }),
    link.tpwdCore,
  );
  const fresh = await ticketFor(t, link);
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, fresh, { ip: '203.0.113.32' }))).toBe(
    link.tpwd,
  );
}, 60_000);

it('[AC-B1-15u#6] 取口令的 UA 为微信内置浏览器、缺失或为空 → 20001 data.fields=[ticket]，不返回口令', async () => {
  const t = await h.tenant();
  const link = await taobaoShare(t);
  const ticket = await ticketFor(t, link);
  let address = 40;
  for (const ua of WECHAT_LIKE) {
    address++;
    await expectTicketRefused(
      await h.tpwd(t.appId, link.linkId, ticket, { ua, ip: `203.0.113.${address}` }),
      link.tpwdCore,
    );
  }
  const fresh = await ticketFor(t, link);
  expect(
    await tpwdOf(
      await h.tpwd(t.appId, link.linkId, fresh, { ua: UA.chromeAndroid, ip: '203.0.113.49' }),
    ),
  ).toBe(link.tpwd);
}, 60_000);

it('[AC-B1-15u#6] 伪造或篡改的票据、没有口令的 link → 20001 data.fields=[ticket]，不返回口令', async () => {
  const t = await h.tenant();
  const link = await taobaoShare(t);
  const jd = await t.link(await t.sharer(), 'jd');
  const ticket = await ticketFor(t, link);
  let address = 50;
  for (const forged of ['forged-ticket', randomUUID(), String(link.tpwd), tampered(ticket)]) {
    address++;
    await expectTicketRefused(
      await h.tpwd(t.appId, link.linkId, forged, { ip: `203.0.113.${address}` }),
      link.tpwdCore,
    );
  }
  await expectTicketRefused(
    await h.tpwd(t.appId, jd.linkId, ticket, { ip: '203.0.113.58' }),
    link.tpwdCore,
  );
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, ticket, { ip: '203.0.113.59' }))).toBe(
    link.tpwd,
  );
}, 60_000);

it('[AC-B1-15u#7] 同一 IP 对同一 link 每分钟超过 5 次 → 42901 带 Retry-After；别的 IP、别的 link 不受影响；过一分钟恢复', async () => {
  const t = await h.tenant();
  const first = await taobaoShare(t);
  const second = await taobaoShare(t);
  const tickets = [await ticketFor(t, first), await ticketFor(t, first)];
  const spare = await ticketFor(t, first);
  const ip = '203.0.113.61';
  for (let request = 0; request < DEFAULT_RATE; request++) {
    const ticket = tickets[Math.floor(request / TICKET_USES)]!;
    expect(await tpwdOf(await h.tpwd(t.appId, first.linkId, ticket, { ip }))).toBe(first.tpwd);
  }
  const refused = await h.tpwd(t.appId, first.linkId, tickets[1]!, { ip });
  await expectRateLimited(refused, first.tpwdCore);
  expect(await tpwdOf(await h.tpwd(t.appId, first.linkId, spare, { ip: '203.0.113.62' }))).toBe(
    first.tpwd,
  );
  const other = await ticketFor(t, second);
  expect(await tpwdOf(await h.tpwd(t.appId, second.linkId, other, { ip }))).toBe(second.tpwd);
  h.clock.advanceMs(61_000);
  expect(await tpwdOf(await h.tpwd(t.appId, first.linkId, spare, { ip }))).toBe(first.tpwd);
}, 60_000);

it('[AC-B1-15u#7] share.tpwd_rate_per_min 改小后按新值限频（配置经缓存刷新后生效）', async () => {
  const t = await h.tenant();
  const link = await taobaoShare(t);
  const warm = await ticketFor(t, link);
  // Read once under the default, then the operator lowers the limit to 2.
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, warm, { ip: '203.0.113.70' }))).toBe(
    link.tpwd,
  );
  await t.setConfig(RATE_KEY, 2);
  h.clock.advanceMs(120_000);
  const ticket = await ticketFor(t, link);
  const ip = '203.0.113.71';
  for (let request = 0; request < 2; request++) {
    expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, ticket, { ip }))).toBe(link.tpwd);
  }
  await expectRateLimited(await h.tpwd(t.appId, link.linkId, ticket, { ip }), link.tpwdCore);
  const fresh = await ticketFor(t, link);
  expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, fresh, { ip: '203.0.113.72' }))).toBe(
    link.tpwd,
  );
}, 60_000);

/** Not a positive whole number of requests per minute: the code default applies. */
const UNUSABLE_RATES: [unknown][] = [['five'], [-3], [{ per_min: 2 }]];

it.each(UNUSABLE_RATES)(
  '[AC-B1-15u#7] share.tpwd_rate_per_min 为 %j（读不到或越界）时按缺省 5 次限频',
  async (value) => {
    const t = await h.tenant({ [RATE_KEY]: value });
    const link = await taobaoShare(t);
    const tickets = [await ticketFor(t, link), await ticketFor(t, link)];
    const ip = '203.0.113.81';
    for (let request = 0; request < DEFAULT_RATE; request++) {
      const ticket = tickets[Math.floor(request / TICKET_USES)]!;
      expect(await tpwdOf(await h.tpwd(t.appId, link.linkId, ticket, { ip }))).toBe(link.tpwd);
    }
    const refused = await h.tpwd(t.appId, link.linkId, tickets[1]!, { ip });
    await expectRateLimited(refused, link.tpwdCore);
  },
  60_000,
);
