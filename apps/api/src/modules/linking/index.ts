// Public surface of the linking module (规划/02 §4.1); other modules import only from this file.
// Task B1-06c: card-time link registration with its quote snapshot and frozen identity_snapshot
// (BR-PRICE-12, BR-ATTR-05/06/08/14, D33), implementing catalog's LinkRegistrar and
// SourceLinkReader; the CallerContext, attr_code and configuration ports. Rule tests:
// test/spec/linking/register/**.
export { createLinkRegistration, createSourceLinkReader } from './application/link-registration.ts';
export type {
  IdentitySnapshot,
  LinkRegistration,
  LinkingOptions,
  RegistrationContext,
} from './application/link-registration.ts';
export { LinkingError } from './domain/rules.ts';
export type { LinkingErrorCode } from './domain/rules.ts';
export {
  AttrCodeReader,
  CallerContext,
  LinkingConfigReader,
  createGuestCallerContext,
  createUnavailableAttrCodeReader,
} from './ports.ts';
export type { Caller } from './ports.ts';
export { LINK_REGISTRATIONS, LinkingModule } from './linking.module.ts';
export type { LinkRegistrations, LinkingConfigReaderFactory } from './linking.module.ts';

import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import type { IdentitySnapshot, LinkingOptions } from './application/link-registration.ts';

/** B1-06d: ownership stage only; registration uses the existing B1-06c dependencies. */
export type LinkOpenOwnerOptions = Omit<LinkingOptions, 'context'>;

export interface LinkOpenOwnerResult {
  /** The persisted link selected for subsequent authorization/conversion. */
  readonly link: Selectable<DB['links']>;
  readonly identitySnapshot: IdentitySnapshot;
  readonly new_link_id: components['schemas']['OpenLinkResult']['new_link_id'];
  /** Always the original card's quote, even after registering a different owner's link. */
  readonly old_final_price_fen: components['schemas']['OpenLinkResult']['old_final_price_fen'];
  /** Internal message for the later HTTP response, including the taolijin restriction. */
  readonly message: string | null;
}

export interface LinkOpenOwnerService {
  /** CallerContext is the only identity source; unknown/foreign links fail with code 30144. */
  open(input: { readonly linkId: string }): Promise<LinkOpenOwnerResult>;
}

export function createLinkOpenOwner(options: LinkOpenOwnerOptions): LinkOpenOwnerService {
  void options;
  throw new Error('NotImplemented: createLinkOpenOwner');
}
