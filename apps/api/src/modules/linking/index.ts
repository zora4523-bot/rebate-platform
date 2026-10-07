// Public surface of the linking module (规划/02 §4.1); other modules import only from this file.
// Task B1-06c: card-time link registration with its quote snapshot and frozen identity_snapshot
// (BR-PRICE-12, BR-ATTR-05/06/08/14, D33), implementing catalog's LinkRegistrar and
// SourceLinkReader; the CallerContext, attr_code and configuration ports. Rule tests:
// test/spec/linking/register/**.
// Task B1-06d: linking open, first stage — whom the open serves (BR-ATTR-05 ①～⑤, BR-ATTR-11
// default, BR-PRICE-12 baseline). Rule tests: test/spec/linking/open-owner/**.
export { createLinkRegistration, createSourceLinkReader } from './application/link-registration.ts';
export type {
  IdentitySnapshot,
  LinkRegistration,
  LinkingOptions,
  RegistrationContext,
} from './application/link-registration.ts';
export { createLinkOpenOwner } from './application/link-open-owner.ts';
export type {
  LinkOpenOwnerOptions,
  LinkOpenOwnerResult,
  LinkOpenOwnerService,
} from './application/link-open-owner.ts';
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
export { LINK_OPEN_PORTS, LINK_REGISTRATIONS, LinkingModule } from './linking.module.ts';
export type {
  LinkOpenPorts,
  LinkRegistrations,
  LinkingConfigReaderFactory,
} from './linking.module.ts';
// Task B1-06w: the open's production wiring (jump-path admission per environment, apps.json,
// the Redis jump cache). Rule tests: test/spec/linking/wiring/**.
export { createWiredLinkOpen } from './application/link-open-wiring.ts';
export type {
  LinkOpenApps,
  LinkOpenEnvironment,
  LinkOpenQuoteReads,
  WiredLinkOpenOptions,
} from './application/link-open-wiring.ts';
export { openScopedConfig } from './application/link-open-reads.ts';
export { loadLinkOpenApps } from './infra/apps-json.ts';
export { createLinkOpenRequote } from './application/link-open-requote.ts';
export type {
  LinkOpenCacheKey,
  LinkOpenCachedJump,
  LinkOpenConversionInput,
  LinkOpenJump,
  LinkOpenPrice,
  LinkOpenRequoteInput,
  LinkOpenRequoteOptions,
  LinkOpenRequoteOutcome,
  LinkOpenRequoteResult,
  LinkOpenRequoteService,
} from './application/link-open-requote.ts';
// Task B1-06j: GET /v1/links/{link_id}, the read-only card of the in-app link landing page
// (BR-ATTR-05 细则「App 内打开链接的入口」, BR-ATTR-10/11, BR-PRICE-06). Rule tests:
// test/spec/linking/landing/**.
export {
  LinkLandingService,
  createLandingLinks,
  createLinkLanding,
  createSnapshotCardReader,
} from './application/link-landing.ts';
export type {
  LandingLink,
  LinkLandingInput,
  LinkLandingOptions,
  SnapshotCardOptions,
} from './application/link-landing.ts';
