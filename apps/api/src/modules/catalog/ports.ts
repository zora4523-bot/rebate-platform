// The five ports catalog uses (its callers' providers implement them; app.module.ts and the
// catalog module assemble them). Each abstract class is both the type and the Nest injection
// token, so the tokens are distinct by construction.
//   LinkRegistrar     linking implements, B1-06c wires: a card registers its link and quote
//                     snapshot only, never converts (BR-PRICE-12).
//   SourceLinkReader  linking implements, B1-06c wires: entry_source of the originating link,
//                     read only, for detail inheritance (BR-PRICE-07).
//   RebateQuoter      quotation (BR-CALC-20 / BR-PRICE-06); the real one is B2-03, B1-05f a demo.
//   ViewerContext     identity implements, wired by B1-02m; until then every viewer is a guest.
//   CatalogConfigReader content's ContentReader (F1-02b), wired in CatalogModule; later catalog
//                     tasks read configuration only through it, never by importing content.
// LinkRegistrar, SourceLinkReader and RebateQuoter have no provider yet: services that need them
// are registered once their implementations are wired (no placeholder implementation).
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { UnionItem } from '../union/index.ts';
import type { ProductRef } from './domain/types.ts';

export interface Viewer {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

export abstract class ViewerContext {
  abstract current(): Promise<Viewer>;
}

class GuestViewerContext extends ViewerContext {
  readonly #viewer: Viewer;

  constructor(appId: string, deviceId: string | null) {
    super();
    this.#viewer = Object.freeze({ appId, userId: null, deviceId });
  }

  current(): Promise<Viewer> {
    return Promise.resolve({ ...this.#viewer });
  }
}

/**
 * The default until identity is wired (B1-02m): always a guest (userId null) of the server-side
 * app and device scope. Any user id the caller carries is ignored, so endpoints that require a
 * login fail closed.
 */
export function createGuestViewerContext(scope: {
  readonly appId: string;
  readonly deviceId: string | null;
}): ViewerContext {
  return new GuestViewerContext(scope.appId, scope.deviceId);
}

export interface RebateQuote {
  readonly rebateMinFen: bigint | null;
  readonly rebateMaxFen: bigint | null;
  readonly estNetPriceFen: bigint | null;
  readonly rebateBasis: components['schemas']['ProductCard']['rebate_basis'];
}

export abstract class RebateQuoter {
  abstract quote(item: UnionItem, viewer: Viewer): Promise<RebateQuote>;
}

export interface RegisterLinkInput {
  readonly viewer: Viewer;
  readonly ref: ProductRef;
  readonly item: UnionItem;
  readonly quote: RebateQuote;
  /** Opaque value read from the originating link, not a newly invented enumeration. */
  readonly entrySource: string | null;
}

export abstract class LinkRegistrar {
  abstract register(input: RegisterLinkInput): Promise<{ readonly linkId: string }>;
}

export abstract class SourceLinkReader {
  abstract entrySource(appId: string, linkId: string): Promise<string | null>;
}

/** Structurally matches content's public read port (ContentReader.configValue). */
export abstract class CatalogConfigReader {
  abstract configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null>;
}
