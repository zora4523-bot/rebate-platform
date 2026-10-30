// B1-22p: material-channel ranking port of the union module (BR-TEXT-17 细则「联盟物料频道」).
// Only a (platform, channel) listed in specs/material-channels.yaml with selectable: true is
// fetched, checked again on every call; anything else is no data plus a warning, and the adapter
// is not called. Items come back in the channel's own order with the union's sales field as is.
// Rule tests: test/spec/union/channel-ranking/**.
import type { MaterialChannelsSpec, RootLogger } from '../../platform/index.ts';
import type {
  CallCtx,
  ChannelRankingCategory,
  ChannelRankingPage,
  Platform,
  UnionAdapter,
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

export function createUnionChannelRanking(
  options: UnionChannelRankingOptions,
): UnionChannelRanking {
  void options;
  throw new Error('NotImplemented: createUnionChannelRanking');
}
