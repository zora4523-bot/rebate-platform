// B1-28h: the union side of the hot-sales list (HotRankUpstream) in the server's wiring.
// The union adapters have no channel-scoped list yet: MaterialReq carries only a cursor, no
// channel_id, no category and no sales field, and the platform ranking capabilities (规划/09
// CAP-TB-10, CAP-JD-10, CAP-PDD-10) are not recorded. Serving the generic material feed under a
// whitelisted channel's name would not be that channel's order (F-PROD-13 ②), so every call
// fails as a union outage (50304 without reason) instead. With the whitelist empty today the use
// case answers rank_unavailable before ever reaching this side.
// TODO(规划/11 §4.5): 按 channel_id / 类目取联盟榜单频道并透传销量字段 — blocked on 联盟 MaterialReq 的频道参数与 CAP-TB-10、CAP-JD-10、CAP-PDD-10 实测记录
import { UnionError, type Platform } from '../../union/index.ts';
import type { HotRankUpstream } from '../hot-rank.ts';

function noChannelList(platform: Platform): Promise<never> {
  return Promise.reject(
    new UnionError(
      'upstream_unavailable',
      'rank: the union adapter has no channel-scoped hot list',
      platform,
    ),
  );
}

export function createUnionHotRankUpstream(): HotRankUpstream {
  return {
    categories: (input) => noChannelList(input.platform),
    page: (input) => noChannelList(input.platform),
  };
}
