import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import type { HandlerResult } from '../../platform/index.ts';
import type { CallerContext } from '../ports.ts';

export type LandingLink = Selectable<DB['links']>;

/** Read ports only: card loading must not register, open or convert a link. */
export interface LinkLandingOptions {
  readonly callerContext: CallerContext;
  readonly links: {
    find(appId: string, linkId: string): Promise<LandingLink | null>;
  };
  readonly cards: {
    read(link: LandingLink): Promise<components['schemas']['ProductCard']>;
  };
}

export interface LinkLandingInput {
  readonly linkId: string;
  readonly traceId: string;
}

export class LinkLandingService {
  get(input: LinkLandingInput): Promise<HandlerResult> {
    void input;
    throw new Error('NotImplemented: LinkLandingService.get');
  }
}

export function createLinkLanding(options: LinkLandingOptions): LinkLandingService {
  void options;
  throw new Error('NotImplemented: createLinkLanding');
}
