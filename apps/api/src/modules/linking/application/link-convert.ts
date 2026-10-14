import type { components } from '@couli/contracts-ts';
import type { Catalog, CardRebateQuoter, ItemRefService, ProductRef } from '../../catalog/index.ts';
import type { HandlerResult } from '../../platform/index.ts';
import type { CallCtx, UnionItemDetail } from '../../union/index.ts';
import type { LinkOpenInput } from './link-open.ts';
import type { TaobaoLinkOpenOptions } from './link-open-taobao.ts';

/** Implemented structurally by parsing.parseUrl, assembled in AppModule. */
export interface LinkConvertUrlParser {
  parseUrl(
    url: string,
    context: CallCtx,
  ): Promise<{
    readonly item: UnionItemDetail;
    readonly ref: ProductRef;
  }>;
}

export interface LinkConvertInput {
  readonly body: components['schemas']['ConvertLinkRequest'];
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly client: LinkOpenInput['client'];
}

export interface LinkConvertOptions extends TaobaoLinkOpenOptions {
  readonly products: Catalog;
  readonly itemRefs: ItemRefService;
  readonly quoter: CardRebateQuoter;
  readonly urlParser: LinkConvertUrlParser;
}

export class LinkConvertService {
  convert(input: LinkConvertInput): Promise<HandlerResult> {
    void input;
    throw new Error('NotImplemented: LinkConvertService.convert');
  }
}

export function createLinkConvert(options: LinkConvertOptions): LinkConvertService {
  void options;
  throw new Error('NotImplemented: createLinkConvert');
}
