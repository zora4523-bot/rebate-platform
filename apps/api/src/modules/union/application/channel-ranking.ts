// B1-22p: material-channel ranking port of the union module (BR-TEXT-17 细则「联盟物料频道」).
// Only a (platform, channel) listed in specs/material-channels.yaml with selectable: true is
// fetched, checked again on every call; anything else is no data plus a warning, and the adapter
// is not called. Items come back in the channel's own order with the union's sales field as is.
// Rule tests: test/spec/union/channel-ranking/**.
import type { MaterialChannelsSpec, RootLogger } from '../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ChannelRankingCategory,
  type ChannelRankingPage,
  type Platform,
  type UnionAdapter,
} from '../domain/types.ts';

export interface ChannelRankingCategoriesInput {
  readonly appId: string;
  readonly platform: Platform;
  readonly channelId: string;
}

export interface ChannelRankingPageInput extends ChannelRankingCategoriesInput {
  /** null for the whole list. */
  readonly categoryId: string | null;
  /** Integer from 1. */
  readonly pageNo: number;
  /** Integer 1..50. */
  readonly pageSize: number;
}

export interface UnionChannelRankingOptions {
  /** Production: the governed adapter of the platform (same path as materialFeed). */
  readonly adapterFor: (platform: Platform) => UnionAdapter | undefined;
  /** Production: platform's getMaterialChannels; read again on every call. */
  readonly channels: () => MaterialChannelsSpec;
  /** Builds the CallCtx of one call, as the existing materialFeed callers do. */
  readonly callCtx: (input: { readonly appId: string; readonly platform: Platform }) => CallCtx;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export interface UnionChannelRanking {
  categories(input: ChannelRankingCategoriesInput): Promise<readonly ChannelRankingCategory[]>;
  page(input: ChannelRankingPageInput): Promise<ChannelRankingPage>;
}

/** Page bounds of the port (B1-22p): pageNo an integer from 1, pageSize an integer 1..50. */
const MAX_PAGE_SIZE = 50;
const EMPTY_PAGE: ChannelRankingPage = Object.freeze({ items: Object.freeze([]), hasMore: false });

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function createUnionChannelRanking(
  options: UnionChannelRankingOptions,
): UnionChannelRanking {
  const { adapterFor, channels, callCtx, logger } = options;

  /**
   * BR-TEXT-17 细则: the whitelist is read again on every call; only an exact (platform,
   * channel_id) entry with selectable === true passes. A refusal logs one warning naming the
   * platform and channel (never the call context or any credential).
   */
  const allowed = (input: ChannelRankingCategoriesInput, operation: string): boolean => {
    const listed = channels().channels.find(
      (entry) => entry.platform === input.platform && entry.channel_id === input.channelId,
    );
    if (listed !== undefined && listed.selectable === true) return true;
    logger.warn(
      {
        event: 'union_channel_refused',
        operation,
        platform: input.platform,
        channelId: input.channelId,
        reason: listed === undefined ? 'not_listed' : 'not_selectable',
      },
      'material channel not selectable in specs/material-channels.yaml; no union call, no data',
    );
    return false;
  };

  /** A missing adapter or a missing channel method is a union outage (catalog maps 50304). */
  const outage = (platform: Platform, operation: string): UnionError =>
    new UnionError(
      'upstream_unavailable',
      `Union adapter for ${platform} offers no ${operation}`,
      platform,
    );

  return {
    async categories(input) {
      if (!allowed(input, 'channelCategories')) return [];
      const adapter = adapterFor(input.platform);
      const method = adapter?.channelCategories;
      if (adapter === undefined || method === undefined) {
        throw outage(input.platform, 'channelCategories');
      }
      const ctx = callCtx({ appId: input.appId, platform: input.platform });
      // The adapter's order and content as is; its errors propagate unchanged.
      return await method.call(adapter, { channelId: input.channelId }, ctx);
    },

    async page(input) {
      if (!isIntegerIn(input.pageNo, 1, Number.MAX_SAFE_INTEGER)) {
        throw new UnionError('invalid_dto', 'pageNo must be an integer from 1', input.platform);
      }
      if (!isIntegerIn(input.pageSize, 1, MAX_PAGE_SIZE)) {
        throw new UnionError(
          'invalid_dto',
          `pageSize must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`,
          input.platform,
        );
      }
      if (input.categoryId !== null && typeof input.categoryId !== 'string') {
        throw new UnionError('invalid_dto', 'categoryId must be a string or null', input.platform);
      }
      if (!allowed(input, 'channelRanking')) return EMPTY_PAGE;
      const adapter = adapterFor(input.platform);
      const method = adapter?.channelRanking;
      if (adapter === undefined || method === undefined) {
        throw outage(input.platform, 'channelRanking');
      }
      const ctx = callCtx({ appId: input.appId, platform: input.platform });
      // No re-sorting, filtering or commission weight (BR-TEXT-17); amounts stay bigint as given.
      return await method.call(
        adapter,
        {
          channelId: input.channelId,
          categoryId: input.categoryId,
          pageNo: input.pageNo,
          pageSize: input.pageSize,
        },
        ctx,
      );
    },
  };
}
