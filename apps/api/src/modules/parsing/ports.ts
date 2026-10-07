// The configuration port parsing reads (parse.tpwd.enabled, product_key.jd.mode). content's
// ContentReader implements it (F1-02b); app.module.ts assembles it through ParsingModule, so
// parsing never imports content. The abstract class is both the type and the Nest token.
import type { DB } from '@couli/db';
import type {
  CardRebateQuoter,
  Catalog,
  ItemRefService,
  LinkRegistrar,
  SourceLinkReader,
} from '../catalog/index.ts';
import type { RegisteredPlatform, UnionAdapter } from '../union/index.ts';

export abstract class ParsingConfigReader {
  abstract configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null>;
}

/**
 * What the POST /v1/inputs/parse route needs besides the configuration port (B1-07b): catalog's
 * dictionary reads, the governed union adapters and the card entry's quoter, entry_source reader
 * and item_ref issuer. ParsingModule assembles it once per process from app.module's global
 * providers (B1-05j); only a process without a database handle (isolated HTTP unit tests) has
 * catalog reads that fail when called (the hit then ends with 50001 and a warning).
 */
export interface ParsingRoutePorts {
  readonly catalog: Pick<Catalog, 'listPlatforms' | 'resolveProductKey'>;
  readonly getGovernedAdapter: (
    platform: RegisteredPlatform,
  ) => Pick<UnionAdapter, 'resolveLink' | 'getItem'>;
  readonly quoter: CardRebateQuoter;
  readonly sourceLinks: SourceLinkReader;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
}

/** Nest injection token of ParsingRoutePorts. */
export const PARSING_ROUTE_PORTS = Symbol('PARSING_ROUTE_PORTS');

/** Entry scenes of POST /v1/inputs/parse (contract ParseInputRequest.scene). */
export type ParseScene = 'clipboard' | 'search' | 'share_ext';

/**
 * Card-time link registration in the request's entry scene (BR-PRICE-12): linking implements it
 * per request; app.module.ts provides it so parsing never imports linking (规划/02 §4.1). The
 * abstract class is both the type and the Nest token.
 */
export abstract class ParsingLinkRegistrars {
  abstract forScene(scene: ParseScene): LinkRegistrar;
}
