// Pure registration rules of linking (B1-06c): scene validation and the pid_scene it implies
// (BR-ATTR-08), the URL lifetime behind expire_at (BR-ATTR-05), which registrations are logged
// (BR-ATTR-14) and how a boolean switch reads; B1-06d adds whom an open serves (BR-ATTR-05
// ①～⑤, BR-ATTR-11). No Nest, no data access.
import { scene as SCENES, type PidScene, type Scene } from '@couli/contracts-ts';

/**
 * The contract errors linking fails with (contracts/error-codes.yaml): 20001 invalid scene,
 * 10001 login required, 30144 link unknown or of another app.
 */
export type LinkingErrorCode = 20001 | 10001 | 30144;

export class LinkingError extends Error {
  readonly code: LinkingErrorCode;
  readonly data: { readonly fields: readonly string[]; readonly reason: string };

  constructor(code: LinkingErrorCode, reason: string, fields: readonly string[]) {
    super(`linking: ${reason}`);
    this.name = 'LinkingError';
    this.code = code;
    this.data = { fields, reason };
  }
}

/** The request scene, or 20001 when it is missing or outside the contract enum (BR-ATTR-08). */
export function parseScene(value: unknown): Scene {
  if (typeof value !== 'string' || !(SCENES as readonly string[]).includes(value)) {
    throw new LinkingError(20001, 'scene_invalid', ['scene']);
  }
  return value as Scene;
}

const PID_SCENES: Readonly<Record<Scene, PidScene>> = {
  search: 'self_buy',
  detail: 'self_buy',
  home_card: 'self_buy',
  feed: 'self_buy',
  clipboard: 'self_buy',
  h5: 'self_buy',
  push: 'self_buy',
  agent: 'agent',
  share: 'share',
  taolijin: 'taolijin',
  watch_alert: 'self_buy',
  share_ext: 'self_buy',
  wechat_bot: 'self_buy',
  mcp: 'agent',
};

/** BR-ATTR-08: the server derives pid_scene from scene; fallback and query are never derived. */
export function pidSceneOf(scene: Scene): PidScene {
  return PID_SCENES[scene];
}

/** BR-ATTR-05: share URLs 7 days, self-buy and Agent URLs 15 minutes, from registration. */
export const SHARE_URL_LIFETIME_MS = 604_800_000;
export const URL_LIFETIME_MS = 900_000;

export function urlLifetimeMs(pidScene: PidScene): number {
  return pidScene === 'share' ? SHARE_URL_LIFETIME_MS : URL_LIFETIME_MS;
}

/** BR-ATTR-14: a card registration is logged only for Agent and watch-alert cards. */
export function logsRegistration(scene: Scene, pidScene: PidScene): boolean {
  return pidScene === 'agent' || scene === 'watch_alert';
}

/** A boolean switch is on for JSON true or the string 'on'; anything else (absent too) is off. */
export function isSwitchOn(value: unknown): boolean {
  return value === true || value === 'on';
}

/** The configuration switch that admits scene=taolijin (contracts scene enum, BR-ATTR-08). */
export const TLJ_SWITCH = 'tlj.enabled';

/** The scene and pid_scene an opener's own link falls back to: self-buy detail (BR-ATTR-11). */
export const SELF_BUY_SCENE: Scene = 'detail';

/** The notice when another user's taolijin link is reopened on the self-buy pid (BR-ATTR-05③). */
export const TLJ_OWNER_ONLY_MESSAGE = '该淘礼金仅限原用户使用';

/**
 * Whom an open serves (BR-ATTR-05 ①～④, BR-ATTR-11 default):
 * - use: open the stored link as it is (the sharer's identity, or the caller's own link);
 * - claim: a guest link the caller claims once (links.user_id, conditional update);
 * - register: register a new link for the caller (scene given), the original stays untouched;
 * - login: 10001.
 */
export type OpenOwnerDecision =
  | { readonly kind: 'use' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'register'; readonly scene: Scene; readonly message: string | null }
  | { readonly kind: 'login' };

export function decideOpenOwner(input: {
  /** pid_scene of the stored link. */
  readonly pidScene: string | null;
  /** The link's scene (contract enum); taolijin falls back to detail for another user. */
  readonly scene: Scene;
  /** identity_snapshot.user_id: the owner for share links (①) and for the others (②③). */
  readonly snapshotUserId: string | null;
  /** links.user_id, set when a guest link is claimed. */
  readonly rowUserId: string | null;
  /** The current caller from CallerContext only; null is a guest. */
  readonly callerUserId: string | null;
}): OpenOwnerDecision {
  const { pidScene, scene, snapshotUserId, rowUserId, callerUserId } = input;
  if (pidScene === 'share') {
    // ①: anyone opens with the sharer's identity; the sharer himself goes self-buy (BR-ATTR-11).
    if (callerUserId !== null && callerUserId === snapshotUserId) {
      return { kind: 'register', scene: SELF_BUY_SCENE, message: null };
    }
    return { kind: 'use' };
  }
  // ④: a non-share link needs a logged-in caller, whoever owns it.
  if (callerUserId === null) return { kind: 'login' };
  const owner = snapshotUserId ?? rowUserId;
  // ②: the caller's own link, or a guest link not yet claimed.
  if (owner === callerUserId) return { kind: 'use' };
  if (owner === null) return { kind: 'claim' };
  // ③: another user's link; taolijin is never created for the caller (detail, self-buy).
  return scene === 'taolijin'
    ? { kind: 'register', scene: SELF_BUY_SCENE, message: TLJ_OWNER_ONLY_MESSAGE }
    : { kind: 'register', scene, message: null };
}
