// Public surface of the linking module (规划/02 §4.1); other modules import only from this file.
export { createClaimEvidenceReader } from './application/claim-evidence-reader.ts';
export type {
  ClaimEvidenceScope,
  ClaimEvidenceLog,
  ClaimEvidenceBinding,
  ClaimEvidenceConflict,
  ClaimEvidenceReader,
} from './application/claim-evidence-reader.ts';
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
export { inOpenReads, openScopedReader } from './application/link-open-reads.ts';
export type { LinkOpenReadPlan } from './application/link-open-reads.ts';
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
// Task B1-06i: POST /v1/links/convert, register and open in one request for entries without a
// link_id (H5 trade.convertAndOpen; BR-PROD-03 / 11, BR-ATTR-08 / 14). Rule tests:
// test/spec/linking/convert/**.
export { LinkConvertService, createLinkConvert } from './application/link-convert.ts';
export type {
  LinkConvertInput,
  LinkConvertOptions,
  LinkConvertUrlParser,
} from './application/link-convert.ts';
export type { LinkConvertPorts } from './linking.module.ts';
export { createOrderLinkReader } from './application/order-link-reader.ts';
export type { OrderLinkProducts } from './application/order-link-reader.ts';
// Task B1-08m: the open attempts port of orders' pending-track cards (BR-ATTR-21): the user's
// attempts with their open log's facts and later authorization, and the one dismissed_at write.
export { createPendingAttemptStore } from './application/pending-attempts.ts';
export type {
  PendingAttempt,
  PendingAttemptScope,
  PendingAttemptStore,
} from './application/pending-attempts.ts';
// Task F1-07c: the console's union authorization management (reset / disable / enable,
// BR-ID-20; admin entry only) and the ban / unban ports F1-07d calls on its own transaction.
// Rule tests: test/spec/linking/admin-union-bindings/**.
export { blockForBan, restoreAfterUnban } from './application/binding-risk.ts';
export type { BindingRiskInput } from './application/binding-risk.ts';
export { LinkingAdminModule } from './linking-admin.module.ts';
export type { LinkingAdminOptions, LinkingAuditWriterFactory } from './linking-admin.module.ts';
// B1-08n: orders' relation_id binding reader (every status, raw instants), assembled by app.module.
export { createOrderBindingReader } from './infra/order-binding-reader.ts';
// B1-08q: orders' source backfill reader (link_logs of one App, user and platform in a closed
// created_at range, unfiltered), assembled by app.module.
export { createOrderSourceReader } from './infra/order-source-reader.ts';
export type {
  OrderSourceLog,
  OrderSourceLogScope,
  OrderSourceReader,
} from './infra/order-source-reader.ts';
