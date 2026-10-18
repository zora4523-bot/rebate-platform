// Page audience facts for GET /v1/pages/{page_key} (tasks F1-09g, F1-09j; 03 §6.1; BR-INV-23;
// 编排者默认 G1–G4). Only facts the server can read at request time: has_parent, union_authorized, has_order.
// The reads come from other modules' public read ports, assembled by app.module as
// PageAudienceReads (content never imports identity / linking / growth / orders). Facts are read per
// request and never cached across requests.
//
// - union_authorized: taobao or pdd binding `active` (G1). Any other status is not authorized. When
//   no platform is active and some platform read failed, the fact is unknown (9.12 followup).
// - has_order: the user's orders in this app, any status (G2).
// - has_parent: users.parent_id via growth's parent-relation reader (F1-09j; BR-INV-11); app.module
//   maps "no user row in this app" to false. Read only when a section needs it.
// - A failed read makes only that fact unknown (null, matching `any` only) and warns (G4).
import type { Logger } from 'pino';
import type { AudienceFacts } from '../domain/pages/select/index.ts';

export type { AudienceFacts } from '../domain/pages/select/index.ts';

/** Assembled by content from app.module's PageAudienceReads. */
export interface PageAudienceFacts {
  /**
   * The logged-in user's facts. `needed` limits which facts are read (the others come back null);
   * omitted → all three.
   */
  facts(
    appId: string,
    userId: string,
    needed?: ReadonlySet<keyof AudienceFacts>,
  ): Promise<AudienceFacts>;
}

/** The platforms whose authorization counts for union_authorized (03 §6.1「淘宝 / 拼多多」). */
export const AUDIENCE_UNION_PLATFORMS = ['taobao', 'pdd'] as const;
export type AudienceUnionPlatform = (typeof AUDIENCE_UNION_PLATFORMS)[number];

/** Cross-module read ports, assembled by app.module over the owners' index.ts exports. */
export interface PageAudienceReads {
  /** linking's binding projection status for (app, user, platform). */
  unionBindingStatus(
    appId: string,
    userId: string,
    platform: AudienceUnionPlatform,
  ): Promise<string>;
  /** identity's count of the user's orders in this app, any status. */
  orderCount(appId: string, userId: string): Promise<number>;
  /**
   * Whether the user has a parent in this app, from growth's parent-relation read port (F1-09j).
   * app.module always supplies it; optional only for assemblies that serve no has_parent page.
   */
  readonly hasParent?: (appId: string, userId: string) => Promise<boolean>;
}

/** A guest: no user, so every fact is false (no reads). */
export const GUEST_AUDIENCE: AudienceFacts = {
  hasParent: false,
  unionAuthorized: false,
  hasOrder: false,
};

export const UNKNOWN_AUDIENCE: AudienceFacts = {
  hasParent: null,
  unionAuthorized: null,
  hasOrder: null,
};

const ACTIVE = 'active';

/**
 * union_authorized from the per-platform reads: true when any platform is active (even if another
 * read failed), null when none is active and some read failed, else false.
 */
export function unionAuthorizedFrom(
  results: readonly PromiseSettledResult<string>[],
): boolean | null {
  if (results.some((result) => result.status === 'fulfilled' && result.value === ACTIVE)) {
    return true;
  }
  return results.some((result) => result.status === 'rejected') ? null : false;
}

function attempt<T>(read: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(read);
}

export interface PageAudienceFactsDeps {
  /** null: no database handle; every logged-in fact is unknown. */
  readonly reads: PageAudienceReads | null;
  readonly logger: Pick<Logger, 'warn'>;
}

export function createPageAudienceFacts(deps: PageAudienceFactsDeps): PageAudienceFacts {
  const { reads, logger } = deps;
  const warn = (appId: string, fact: string, error: unknown): void => {
    logger.warn(
      {
        event: 'content_page_audience_unavailable',
        app_id: appId,
        fact,
        err: error instanceof Error ? error.message : String(error),
      },
      'page audience fact unavailable; only `any` matches it',
    );
  };
  return {
    async facts(appId, userId, needed) {
      if (reads === null) return UNKNOWN_AUDIENCE;
      const wants = (fact: keyof AudienceFacts): boolean =>
        needed === undefined || needed.has(fact);

      const union = wants('unionAuthorized')
        ? Promise.allSettled(
            AUDIENCE_UNION_PLATFORMS.map((platform) =>
              attempt(() => reads.unionBindingStatus(appId, userId, platform)),
            ),
          ).then((results) => {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed !== undefined) warn(appId, 'union_authorized', failed.reason);
            return unionAuthorizedFrom(results);
          })
        : Promise.resolve(null);

      const order = wants('hasOrder')
        ? attempt(() => reads.orderCount(appId, userId)).then(
            (count) => count > 0,
            (error: unknown) => {
              warn(appId, 'has_order', error);
              return null;
            },
          )
        : Promise.resolve(null);

      const readParent = reads.hasParent;
      const parent =
        wants('hasParent') && readParent !== undefined
          ? attempt(() => readParent(appId, userId)).then(
              (value) => value,
              (error: unknown) => {
                warn(appId, 'has_parent', error);
                return null;
              },
            )
          : Promise.resolve(null);

      const [unionAuthorized, hasOrder, hasParent] = await Promise.all([union, order, parent]);
      return { hasParent, unionAuthorized, hasOrder };
    },
  };
}
