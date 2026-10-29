// Implementer unit tests of the share page use case (B1-15u); the rules are in
// test/spec/linking/share-page/**. No database, no Redis: every port here is an in-memory stand-in.
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { LandingLink } from './link-landing.ts';
import {
  SHARE_TICKET_TTL_MS,
  SharePageMaterials,
  createSharePage,
  isWeChatAgent,
  landingDeepLink,
  retryAfterSec,
  type SharePageMaterial,
  type SharePageOptions,
  type ShareTicketStore,
} from './share-page.ts';

const APP = 'synthetic_share_unit';
const LINK = '0199a3b4-5c6d-7000-8000-0000000015b1';
const SHARER = '0199a3b4-5c6d-7000-8000-0000000015b2';
const QUOTED = '2026-10-30T01:58:30.000Z';
const NOW = '2026-10-30T02:00:00.000Z';
const TRACE = 'synthetic-trace';
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WECHAT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI';
const TOKEN = '￥SynUnitTpwd01￥';
const JUMP = 'https://s.click.example.test/t?e=unit01';

function link(overrides: Partial<LandingLink> = {}): LandingLink {
  return {
    link_id: LINK,
    lk: null,
    app_id: APP,
    user_id: SHARER,
    device_id: null,
    platform: 'taobao',
    product_key: 'taobao:syn-unit',
    raw_item_id: 'syn-item-01',
    raw_fetched_at: new Date(QUOTED),
    scene: 'share',
    sub_scene: null,
    pid_scene: 'share',
    pid: 'synthetic-share',
    entry_source: 'search',
    identity_snapshot: { user_id: SHARER, platform: 'taobao', pid_scene: 'share' },
    convert_result: null,
    cache_hit: false,
    quoted_final_price_fen: 10000n,
    quoted_coupon_fen: 2000n,
    quoted_coupon_id: null,
    quoted_at: new Date(QUOTED),
    expire_at: new Date('2026-11-29T02:00:00.000Z'),
    agent_session_id: null,
    agent_card_id: null,
    row_version: 0,
    created_at: new Date(QUOTED),
    updated_at: new Date(QUOTED),
    promo_url: null,
    promo_url_fetched_at: null,
    ...overrides,
  } as LandingLink;
}

/** The Redis store's semantics in memory: expiry on the given clock, atomic counters. */
function memoryTickets(): ShareTicketStore & { readonly issued: string[] } {
  const tickets = new Map<string, { expiresAtMs: number; uses: number }>();
  const windows = new Map<string, number>();
  const issued: string[] = [];
  return {
    issued,
    issue: async (appId, linkId, expiresAtMs) => {
      const ticket = `unit-ticket-${String(issued.length + 1)}`;
      issued.push(ticket);
      tickets.set(JSON.stringify([appId, linkId, ticket]), { expiresAtMs, uses: 0 });
      return ticket;
    },
    redeem: async (appId, linkId, ticket, nowMs, maxUses) => {
      const entry = tickets.get(JSON.stringify([appId, linkId, ticket]));
      if (entry === undefined || entry.expiresAtMs <= nowMs) return false;
      entry.uses++;
      return entry.uses <= maxUses;
    },
    hit: async (appId, linkId, ip, window) => {
      const key = JSON.stringify([appId, linkId, ip, window]);
      const count = (windows.get(key) ?? 0) + 1;
      windows.set(key, count);
      return count;
    },
  };
}

interface Fixture {
  readonly clock: FixedClock;
  readonly tickets: ReturnType<typeof memoryTickets>;
  readonly options: SharePageOptions;
}

function fixture(
  overrides: {
    link?: LandingLink | null;
    material?: SharePageMaterial | null;
    active?: boolean;
    config?: Readonly<Record<string, unknown>>;
    tickets?: ShareTicketStore;
  } = {},
): Fixture {
  const clock = new FixedClock(NOW);
  const tickets = memoryTickets();
  const row = overrides.link === undefined ? link() : overrides.link;
  const material =
    overrides.material === undefined ? { jumpUrl: JUMP, tpwd: TOKEN } : overrides.material;
  const config = overrides.config ?? {};
  const options: SharePageOptions = {
    clock,
    appEnv: 'test',
    logger: { warn: vi.fn() },
    links: { find: async () => row },
    cards: {
      read: async (l) => ({
        product_key: l.product_key,
        item_ref: null,
        platform: 'taobao',
        shop_type: null,
        title: null,
        image: null,
        shop_name: null,
        price_fen: 12000,
        coupon_fen: 2000,
        final_price_fen: 10000,
        benefit_tags: ['有券'],
        is_presale: false,
        link_id: l.link_id,
        stale: true,
        age_sec: 90,
        source: 'taobao_union',
        disclaimer_keys: ['price_basis'],
        availability: 'ok',
        // A field outside the shared subset never leaves the service.
        ...({ rebate_fen: 123, est_net_price_fen: 9877 } as object),
      }),
    },
    bindings: { active: async () => overrides.active ?? true },
    materials: { read: async () => material },
    config: {
      configValue: async (appId, key) => {
        void appId;
        return Object.hasOwn(config, key) ? { value: config[key] as never, version: 1 } : null;
      },
    },
    tickets: overrides.tickets ?? tickets,
  };
  return { clock, tickets, options };
}

function input(ua: string | null = SAFARI) {
  return { appId: APP, linkId: LINK, traceId: TRACE, userAgent: ua };
}

describe('share page: helpers (B1-15u)', () => {
  it('[AC-B1-15u] WeChat, no and empty User-Agent are judged as WeChat', () => {
    expect(isWeChatAgent(WECHAT)).toBe(true);
    expect(isWeChatAgent(null)).toBe(true);
    expect(isWeChatAgent('  ')).toBe(true);
    expect(isWeChatAgent(SAFARI)).toBe(false);
  });

  it('[AC-B1-15u] the deep link carries link_id only on the link subdomain', () => {
    const url = new URL(landingDeepLink('prod', LINK));
    expect(url.host).toBe('l.couliapp.com');
    expect(url.pathname).toBe('/r/LinkLanding');
    expect([...url.searchParams.entries()]).toEqual([['link_id', LINK]]);
  });

  it('[AC-B1-15u] Retry-After is the rest of the minute window, 1..60', () => {
    expect(retryAfterSec(Date.parse(NOW))).toBe(60);
    expect(retryAfterSec(Date.parse(NOW) + 59_500)).toBe(1);
    expect(retryAfterSec(Date.parse(NOW) + 30_000)).toBe(30);
  });

  it('[AC-B1-15u] the default material is promo_url of a Taobao link only, without token', async () => {
    const materials = new SharePageMaterials();
    expect(await materials.read(link({ promo_url: JUMP }))).toEqual({ jumpUrl: JUMP, tpwd: null });
    expect(await materials.read(link({ promo_url: null }))).toBeNull();
    expect(await materials.read(link({ promo_url: '' }))).toBeNull();
    expect(await materials.read(link({ promo_url: 'not a url' }))).toBeNull();
    expect(await materials.read(link({ platform: 'jd', promo_url: JUMP }))).toBeNull();
  });
});

describe('share page: GET (B1-15u)', () => {
  it('[AC-B1-15u] a browser gets the shared subset, jump_url, deep link and a ticket, never the token', async () => {
    const { options, tickets } = fixture();
    const result = await createSharePage(options).get(input());
    expect(result.status).toBe(200);
    const data = result.envelope.data as Record<string, unknown>;
    expect(data).toMatchObject({
      quoted_at: QUOTED,
      jump_url: JUMP,
      tpwd_ticket: tickets.issued[0],
      open_in_app_url: `https://l.example.test/r/LinkLanding?link_id=${LINK}`,
    });
    const card = data['product_card'] as Record<string, unknown>;
    expect(card).not.toHaveProperty('rebate_fen');
    expect(card).not.toHaveProperty('est_net_price_fen');
    expect(JSON.stringify(result)).not.toContain('SynUnitTpwd01');
  });

  it('[AC-B1-15u] WeChat or no User-Agent gets no ticket; a link without token neither', async () => {
    for (const ua of [WECHAT, null]) {
      const { options, tickets } = fixture();
      const result = await createSharePage(options).get(input(ua));
      expect(result.envelope.data).toMatchObject({ tpwd_ticket: null });
      expect(tickets.issued).toEqual([]);
    }
    const { options } = fixture({ material: { jumpUrl: JUMP, tpwd: null } });
    expect((await createSharePage(options).get(input())).envelope.data).toMatchObject({
      tpwd_ticket: null,
    });
  });

  it('[AC-B1-15u] share.open_in_app.enabled=false → open_in_app_url null', async () => {
    const { options } = fixture({ config: { 'share.open_in_app.enabled': false } });
    const result = await createSharePage(options).get(input());
    expect(result.envelope.data).toMatchObject({ open_in_app_url: null });
  });

  it('[AC-B1-15u] non-share, unknown, malformed or material-less links answer 30144', async () => {
    const cases: Fixture[] = [
      fixture({ link: link({ pid_scene: 'self_buy' }) }),
      fixture({ link: null }),
      fixture({ material: null }),
    ];
    for (const { options } of cases) {
      expect(await createSharePage(options).get(input())).toEqual({
        status: 404,
        envelope: { code: 30144, msg: '链接不存在', trace_id: TRACE },
      });
    }
    const { options } = fixture();
    const find = vi.spyOn(options.links, 'find');
    const result = await createSharePage(options).get({ ...input(), linkId: 'not-a-link-id' });
    expect(result.status).toBe(404);
    expect(find).not.toHaveBeenCalled();
  });

  it('[AC-B1-15u] an inactive sharer binding → 30102 (Taobao) / 30111 (Pinduoduo) sharer_auth_invalid; JD unchecked', async () => {
    const taobao = fixture({ active: false });
    expect(await createSharePage(taobao.options).get(input())).toMatchObject({
      status: 422,
      envelope: { code: 30102, data: { reason: 'sharer_auth_invalid' } },
    });
    const pdd = fixture({ active: false, link: link({ platform: 'pdd' }) });
    expect(await createSharePage(pdd.options).get(input())).toMatchObject({
      status: 422,
      envelope: { code: 30111, data: { reason: 'sharer_auth_invalid' } },
    });
    const jd = fixture({ active: false, link: link({ platform: 'jd' }) });
    expect((await createSharePage(jd.options).get(input())).status).toBe(200);
    const guest = fixture({ link: link({ identity_snapshot: { user_id: null } }) });
    expect((await createSharePage(guest.options).get(input())).envelope.code).toBe(30102);
  });

  it('[AC-B1-15u] a ticket store fault leaves the page without a ticket', async () => {
    const failing = memoryTickets();
    failing.issue = () => Promise.reject(new Error('synthetic'));
    const { options } = fixture({ tickets: failing });
    const result = await createSharePage(options).get(input());
    expect(result.status).toBe(200);
    expect(result.envelope.data).toMatchObject({ tpwd_ticket: null });
  });
});

describe('share page: tpwd (B1-15u)', () => {
  async function ticketOf(f: Fixture): Promise<string> {
    const data = (await createSharePage(f.options).get(input())).envelope.data as {
      tpwd_ticket: string;
    };
    return data.tpwd_ticket;
  }

  function tpwd(f: Fixture, ticket: string, ip: string, ua: string | null = SAFARI) {
    return createSharePage(f.options).tpwd({ ...input(ua), ticket, ip });
  }

  it('[AC-B1-15u] a ticket exchanges 3 times, then 20001 data.fields=[ticket]', async () => {
    const f = fixture();
    const ticket = await ticketOf(f);
    for (let use = 0; use < 3; use++) {
      expect(await tpwd(f, ticket, `192.0.2.${String(use)}`)).toMatchObject({
        status: 200,
        envelope: { code: 0, data: { tpwd: TOKEN } },
      });
    }
    const refused = await tpwd(f, ticket, '192.0.2.9');
    expect(refused).toEqual({
      status: 400,
      envelope: {
        code: 20001,
        msg: '填写内容有误，请检查',
        data: { fields: ['ticket'] },
        trace_id: TRACE,
      },
    });
  });

  it('[AC-B1-15u] expired on the injected clock, WeChat UA or forged → 20001', async () => {
    const f = fixture();
    const ticket = await ticketOf(f);
    expect((await tpwd(f, ticket, '192.0.2.1', WECHAT)).envelope.code).toBe(20001);
    expect((await tpwd(f, ticket, '192.0.2.2', null)).envelope.code).toBe(20001);
    expect((await tpwd(f, 'forged', '192.0.2.3')).envelope.code).toBe(20001);
    f.clock.advanceMs(SHARE_TICKET_TTL_MS);
    expect((await tpwd(f, ticket, '192.0.2.4')).envelope.code).toBe(20001);
  });

  it('[AC-B1-15u] every request counts in the IP × link bucket; over the limit → 42901 with Retry-After', async () => {
    const f = fixture();
    const ticket = await ticketOf(f);
    for (let request = 0; request < 5; request++) {
      expect((await tpwd(f, 'forged', '192.0.2.50')).envelope.code).toBe(20001);
    }
    const limited = await tpwd(f, ticket, '192.0.2.50');
    expect(limited).toMatchObject({ status: 429, envelope: { code: 42901 }, retryAfterSec: 60 });
    expect(JSON.stringify(limited)).not.toContain('SynUnitTpwd01');
    expect((await tpwd(f, ticket, '192.0.2.51')).status).toBe(200);
  });

  it('[AC-B1-15u] share.tpwd_rate_per_min: a valid value applies, an unusable one keeps 5', async () => {
    const lowered = fixture({ config: { 'share.tpwd_rate_per_min': 2 } });
    for (let request = 0; request < 2; request++) {
      expect((await tpwd(lowered, 'forged', '192.0.2.60')).status).toBe(400);
    }
    expect((await tpwd(lowered, 'forged', '192.0.2.60')).status).toBe(429);
    for (const value of ['five', -3, 0, 2.5, { per_min: 2 }]) {
      const f = fixture({ config: { 'share.tpwd_rate_per_min': value } });
      for (let request = 0; request < 5; request++) {
        expect((await tpwd(f, 'forged', '192.0.2.61')).status).toBe(400);
      }
      expect((await tpwd(f, 'forged', '192.0.2.61')).status).toBe(429);
    }
  });

  it('[AC-B1-15u] a rate store fault refuses with 42901 Retry-After 1; no token without material', async () => {
    const failing = memoryTickets();
    failing.hit = () => Promise.reject(new Error('synthetic'));
    const f = fixture({ tickets: failing });
    expect(await tpwd(f, 'any', '192.0.2.70')).toMatchObject({
      status: 429,
      retryAfterSec: 1,
    });
    const none = fixture({ material: { jumpUrl: JUMP, tpwd: null } });
    expect((await tpwd(none, 'any', '192.0.2.71')).envelope.code).toBe(20001);
  });
});
