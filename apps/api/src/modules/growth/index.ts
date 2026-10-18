// growth module public surface (B1-11b): change-log writers and as-of readers. No Nest module and
// no routes in this batch; other modules import only from here.
export { appendLevelChange, appendRelationChange } from './infra/change-logs.ts';
export { createGrowthHistory } from './infra/history.ts';
// B1-11d: every write that changes users.parent_id takes this app-level lock first.
export {
  RELATION_WRITE_LOCK_NAMESPACE,
  lockRelationWrites,
  relationWriteLockKey,
} from './infra/relation-lock.ts';
export type {
  AsOfQuery,
  LevelAt,
  LevelChangeInput,
  LevelChangeSource,
  RelationChangeInput,
  RelationChangeSource,
  UserLevel,
} from './domain/change-logs.ts';
export type { GrowthExecutor, GrowthHistory, GrowthHistoryOptions } from './infra/history.ts';
export { createParentRelationReader } from './ports/parent-relation.ts';
export { createFirstAppLoginReview } from './application/first-app-login-review.ts';
export type {
  FirstAppLoginReviewDeps,
  LandingLoginReview,
  LandingLoginReviewInput,
} from './application/first-app-login-review.ts';
export type {
  ParentRelation,
  ParentRelationReader,
  ParentRelationReaderOptions,
  ParentRelationSubject,
} from './ports/parent-relation.ts';
export {
  createInviteBinder,
  createRegistrationInviteBinding,
} from './application/invite-binder.ts';
export type {
  InviteBindCommand,
  InviteBinder,
  InviteBinderDeps,
  InviteBindingResult,
  InviteSubject,
  InviteActivityReader,
  RegistrationInviteBinding,
  RegistrationInviteInput,
} from './application/invite-binder.ts';
