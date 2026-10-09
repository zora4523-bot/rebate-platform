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
export {
  LINKING_AUTH_APPS,
  LINK_LANDING_PORTS,
  LINK_OPEN_PORTS,
  LINK_REGISTRATIONS,
  LinkingModule,
} from './linking.module.ts';
export type {
  LinkLandingPorts,
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
// Task B1-06f: the Taobao open (Baichuan instruction, 30101 / 30102 / 30153, no_rebate, share
// link) composed over the wired open. Rule tests: test/spec/linking/open-taobao/**.
export { createTaobaoLinkOpen } from './application/link-open-taobao.ts';
export type { TaobaoLinkOpenOptions } from './application/link-open-taobao.ts';
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
// Task B1-06g: GET /v1/unions/{platform}/auth-url, the one-time authorization state (BR-ID-17,
// BR-ID-22, BR-ID-24). Rule tests: test/spec/linking/auth-url/**.
export { createUnionAuthUrl } from './application/union-auth-url.ts';
export type {
  AuthClient,
  UnionAuthMethod,
  UnionAuthUrlInput,
  UnionAuthUrlOptions,
  UnionAuthUrlService,
} from './application/union-auth-url.ts';
export { createDemoUnionAuthApps } from './infra/auth-apps.ts';
export type { UnionAuthApps } from './infra/auth-apps.ts';
// Task B1-06h: POST /v1/unions/{platform}/bindings and GET /v1/unions/bindings (BR-ID-17 细则
// 「授权方式」「授权管理页」, BR-ID-19, BR-ID-24 ④). Rule tests: test/spec/linking/bindings/**.
export { createUnionBindings } from './application/union-bindings.ts';
export type {
  UnionBindInput,
  UnionBindingsListInput,
  UnionBindingsOptions,
  UnionBindingsService,
} from './application/union-bindings.ts';
export { createUnionAuthReads } from './application/union-auth-reads.ts';
export type { UnionAuthReads, UnionAuthReadsOptions } from './application/union-auth-reads.ts';
export { UnionBindingExchanger } from './application/union-binding-exchanger.ts';
export type {
  UnionBindPublisher,
  UnionBindingExchangeInput,
  UnionBindingExchangeResult,
} from './application/union-binding-exchanger.ts';
