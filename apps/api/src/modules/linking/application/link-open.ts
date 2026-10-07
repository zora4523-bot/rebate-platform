import type { components } from '@couli/contracts-ts';
import type { HandlerResult } from '../../platform/index.ts';
import type { LinkConversionOptions } from './link-open-conversion.ts';
import type { LinkOpenRequoteInput, LinkOpenRequoteOptions } from './link-open-requote.ts';

export interface LinkOpenInput extends LinkOpenRequoteInput {
  readonly noRebateReason?: components['schemas']['OpenLinkRequest']['no_rebate_reason'];
}

/** HTTP injection token. Controller takes identity from CallerContext, never body fields. */
export class LinkOpenService {
  open(input: LinkOpenInput): Promise<HandlerResult> {
    void input;
    throw new Error('NotImplemented: LinkOpenService.open');
  }
}

/** Compose ownership/requote with server conversion; serialize fen as safe JSON integers. */
export function createLinkOpen(
  options: Omit<LinkOpenRequoteOptions, 'conversion'> & LinkConversionOptions,
): LinkOpenService {
  void options;
  throw new Error('NotImplemented: createLinkOpen');
}
