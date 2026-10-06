// Pure registration rules of linking (B1-06c): scene validation and the pid_scene it implies
// (BR-ATTR-08), the URL lifetime behind expire_at (BR-ATTR-05), which registrations are logged
// (BR-ATTR-14) and how a boolean switch reads. No Nest, no data access.
import { scene as SCENES, type PidScene, type Scene } from '@couli/contracts-ts';

/** The contract error a registration fails with (contracts/error-codes.yaml). */
export type LinkingErrorCode = 20001;

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
