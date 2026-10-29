// B1-15u: the share page outside the app, GET /v1/share-pages/{link_id}, and its token,
// POST /v1/share-pages/{link_id}/tpwd (BR-ATTR-10 细则「中间页的口令按打开环境区分」「分享页与分享赚
// 入口页」, BR-ATTR-05 细则「App 内打开链接的入口」「别人的分享 link 不可用」; contracts getSharePage /
// getShareTpwd). Skeleton of the rule-test round: every body throws NotImplemented.
// Rule tests: test/spec/linking/share-page/**.
import type { HandlerResult } from '../../platform/index.ts';
import type { LandingLink } from './link-landing.ts';

/** What the sharer's conversion of a share link left for the page outside the app. */
export interface SharePageMaterial {
  /** The sharer's converted short link (data.jump_url); never carries the token. */
  readonly jumpUrl: string;
  /** The link's token (淘口令), handed out only by the tpwd exchange; null when it has none. */
  readonly tpwd: string | null;
}

/**
 * Port and Nest injection token: the share material of one share link, resolved inside
 * LinkingModule (the rule tests replace this provider there). null: the link has no material.
 * Where the material is stored is not fixed by the contract yet (no POST /v1/shares).
 */
export class SharePageMaterials {
  read(link: LandingLink): Promise<SharePageMaterial | null> {
    void link;
    throw new Error('NotImplemented: SharePageMaterials.read');
  }
}

export interface SharePageInput {
  /** X-App-Id of the request (route schema checked); no device and no token are read. */
  readonly appId: string;
  readonly linkId: string;
  readonly traceId: string;
  /** The User-Agent header; null when absent or empty, which is judged as WeChat. */
  readonly userAgent: string | null;
}

export interface ShareTpwdInput extends SharePageInput {
  readonly ticket: string;
  /** Fastify request.ip: the rate limit is per IP × link_id (share.tpwd_rate_per_min). */
  readonly ip: string;
}

export class SharePageService {
  get(input: SharePageInput): Promise<HandlerResult> {
    void input;
    throw new Error('NotImplemented: SharePageService.get');
  }

  tpwd(input: ShareTpwdInput): Promise<HandlerResult> {
    void input;
    throw new Error('NotImplemented: SharePageService.tpwd');
  }
}
