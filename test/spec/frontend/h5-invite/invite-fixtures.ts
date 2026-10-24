import type {
  BridgeErrorCode,
  BridgeMethods,
  BridgeRequest,
  BridgeResponse,
} from '@couli/bridge-sdk';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { installBridge } from '../bridge-sdk/kit.ts';
import { reply, server } from '../h5-notices/fixtures.ts';

export { reply } from '../h5-notices/fixtures.ts';
export type MyInvite = components['schemas']['MyInvite'];
export type ConfigInvite = components['schemas']['ConfigInvite'];

const texts = dictionary.texts;
// 契约字典已有的键（contracts/texts.default.json，BR-TEXT-14 表 A / C / D）。
export const copy = {
  copyCode: texts['invite.share.copy_code'],
  copyLink: texts['invite.share.copy_link'],
  savePoster: texts['invite.share.save_poster'],
  invitedCount: texts['invite.share.invited_count'],
  invitedUnit: texts['invite.share.invited_unit'],
  promoLabel: texts['invite.share.promo_label'],
  promoWhere: texts['invite.share.promo_where'],
  rulesTitle: texts['invite.share.rules_title'],
  rulesFull: texts['invite.share.rules_full'],
  rewardTitle: texts['invite.share.reward_title'],
  rewardRules: texts['invite.share.reward_rules'],
  noReward: texts['invite.share.rule.no_reward'],
  unavailable: texts['invite.share.unavailable'],
  unavailableHint: texts['invite.share.unavailable_hint'],
  copyCodeDone: texts['invite.copy_code.done'],
  copyLinkDone: texts['invite.copy_link.done'],
  rewardTip: texts['invite.reward.tip_inviter'],
  photosDenied: texts['perm.photos.denied_forever'],
  minor: texts['error.30413'],
  needPhone: texts['error.10005'],
  outdated: texts['error.10405'],
  loadFailed: texts['h5.load_failed'],
} as const;

/** The reward sentence's fixed lead-in (before {amount}); absent means no reward sentence shown. */
export const rewardLead = copy.rewardTip.split('{amount}')[0]!.trim();

export const inviteCode = 'K7M2QX';
export const landingUrl = `https://share.example.invalid/i/${inviteCode}?ch=app`;
export const posterUrl = 'https://media.example.invalid/posters/invite-K7M2QX-v3.png';
export const INVITE_PATH = '/v1/invites/me';

export function myInvite(overrides: Partial<MyInvite> = {}): MyInvite {
  return {
    can_invite: true,
    invite_code: inviteCode,
    landing_url: landingUrl,
    poster_url: posterUrl,
    direct_count: 7,
    ...overrides,
  };
}

export const unavailable: MyInvite = {
  can_invite: false,
  invite_code: null,
  landing_url: null,
  poster_url: null,
  direct_count: 4,
};

/** Invite section of /v1/config; `reward` left undefined omits reward_enabled (missing = off). */
export function inviteConfig(
  reward?: { enabled: boolean; amount_fen?: number },
  eligibility_days = 30,
): ConfigInvite {
  return {
    required: false,
    backfill_hours: 168,
    bind_phone_guide: true,
    eligibility_days,
    ...(reward === undefined
      ? {}
      : { reward_enabled: reward.enabled, reward_amount_fen: reward.amount_fen ?? 1000 }),
  };
}

export type HelpLinkTarget = components['schemas']['HelpLinkTarget'];

/**
 * help_links targets of the two invite-page entries (契约 CT-16n，D10-252): invite_rules →
 * 【完整规则】, invite_reward_rules → 【活动规则】. The article ids are obviously fake UUIDs.
 */
export const inviteRulesTarget: HelpLinkTarget = {
  route: 'Help',
  params: { article_id: '00000000-0000-4000-8000-0000000f1051' },
};
export const inviteRewardRulesTarget: HelpLinkTarget = {
  route: 'Help',
  params: { article_id: '00000000-0000-4000-8000-0000000f1052' },
};

/** Only the part of /v1/config this page reads plus a few top-level keys; the rest is not used. */
export function config(invite: ConfigInvite = inviteConfig()): Record<string, unknown> {
  return {
    config_version: 'cfg-invite-1',
    dict_version: 'dict-1',
    h5_base_url: 'https://h5.example.invalid',
    share_domains: ['share.example.invalid'],
    invite,
    help_links: {
      invite_rules: inviteRulesTarget,
      invite_reward_rules: inviteRewardRulesTarget,
    },
  };
}

/**
 * Native answer to app.getConfig (规格 §4：getConfig 经桥读取，照 find-order 先例): either the
 * config values (native hands back only the keys the page asked for) or a bridge error code.
 */
export type ConfigAnswer = { values: Record<string, unknown> } | { failCode: BridgeErrorCode };

export function configAnswer(invite: ConfigInvite = inviteConfig()): ConfigAnswer {
  return { values: config(invite) };
}

/** app.getConfig failed on the native side. */
export const configFailure: ConfigAnswer = { failCode: 90500 };

// Browser-safe data, same as the ledger fixture.
const nativeEnv: BridgeMethods['app.getEnv']['result'] = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const bridgeMethods = [
  'app.getEnv',
  'app.getConfig',
  'auth.getH5Token',
  'nav.open',
  'clipboard.write',
  'media.saveImage',
  'media.previewImage',
  'share.open',
  'cs.open',
  'ui.toast',
] as const;

export interface InviteServerOptions {
  invite?: (count: number) => Response | Promise<Response>;
  /** Native answer for app.getConfig; default: values with the reward campaign off (missing). */
  config?: (count: number) => ConfigAnswer | Promise<ConfigAnswer>;
  /** Native answer for media.saveImage; default saved=true. */
  saveImage?: (request: BridgeRequest) => BridgeResponse;
}

function requestedKeys(request: BridgeRequest): unknown[] {
  const keys = (request.params as { keys?: unknown } | undefined)?.keys;
  return Array.isArray(keys) ? keys : [];
}

/**
 * Real app API + SDK token manager; only the native bridge and the HTTP boundary are fake. The
 * config comes only through app.getConfig; any other HTTP path (including /v1/config) is 30001.
 */
export function inviteServer(options: InviteServerOptions = {}) {
  let tokens = 0;
  let invites = 0;
  let configs = 0;
  const native = installBridge(bridgeMethods, async (request) => {
    const ok = (data: unknown): BridgeResponse => ({ id: request.id, code: 0, msg: '', data });
    switch (request.method) {
      case 'app.getEnv':
        return ok(nativeEnv);
      case 'app.getConfig': {
        configs += 1;
        const answer = await (options.config?.(configs) ?? configAnswer());
        if ('failCode' in answer)
          return { id: request.id, code: answer.failCode, msg: 'config unavailable', data: null };
        const keys = requestedKeys(request);
        return ok({
          values: Object.fromEntries(
            Object.entries(answer.values).filter(([key]) => keys.includes(key)),
          ),
        });
      }
      case 'auth.getH5Token':
        tokens += 1;
        return ok({
          token: `invite-token-${tokens}`,
          scope: 'standard',
          expire_at: '2099-01-01T00:00:00Z',
        });
      case 'nav.open':
        return ok({ opened: true });
      case 'media.saveImage':
        return options.saveImage?.(request) ?? ok({ saved: true });
      case 'share.open':
        return ok({ shared: true });
      case 'cs.open':
        return ok({ opened: true });
      default:
        return ok({});
    }
  });
  const http = server((url) => {
    if (url.pathname === INVITE_PATH) {
      invites += 1;
      return options.invite?.(invites) ?? reply(myInvite());
    }
    return reply(null, 30001, 404);
  });
  const api = createAppApi({
    env: { apiBaseUrl: 'https://api.example.invalid', appId: 'fixture_brand' },
    fetch: http.fetch,
  });
  const calls = (method: string): BridgeRequest[] =>
    native.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === method);
  return {
    api,
    requests: http.requests,
    inviteRequests: () => http.requests.filter((r) => new URL(r.url).pathname === INVITE_PATH),
    tokenCalls: () => tokens,
    calls,
  };
}

export type InviteServer = ReturnType<typeof inviteServer>;
