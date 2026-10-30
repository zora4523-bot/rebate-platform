// B1-28j: the union side of the hot-sales list (HotRankUpstream) in the server's wiring, over the
// union's material-channel ranking port (createUnionChannelRanking, B1-22p). Channel check, order,
// sales field and cache rules stay those of B1-28h.
// Rule tests: test/spec/catalog/hot-rank-upstream/**.
import type { Clock, MaterialChannelsSpec, RootLogger } from '../../platform/index.ts';
import type { Catalog } from '../domain/types.ts';
import type { HotRankUpstream } from '../hot-rank.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';

export interface UnionHotRankUpstreamOptions {
  readonly union: GovernedUnion;
  /** key_prefix of the platform, as search-wiring reads it. */
  readonly catalog: Pick<Catalog, 'listPlatforms'>;
  /** JD item / sku mode (product_key.jd.mode), as search-wiring reads it. */
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
  /** Production: platform's getMaterialChannels; read again before every fetch. */
  readonly channels: () => MaterialChannelsSpec;
  readonly logger: Pick<RootLogger, 'warn'>;
}

export function createUnionHotRankUpstream(options: UnionHotRankUpstreamOptions): HotRankUpstream {
  void options;
  throw new Error('NotImplemented: createUnionHotRankUpstream');
}
