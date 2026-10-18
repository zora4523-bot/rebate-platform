// growth module public surface (B1-11b): change-log writers and as-of readers. No Nest module and
// no routes in this batch; other modules import only from here.
export { appendLevelChange, appendRelationChange } from './infra/change-logs.ts';
export { createGrowthHistory } from './infra/history.ts';
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
export type {
  ParentRelation,
  ParentRelationReader,
  ParentRelationReaderOptions,
  ParentRelationSubject,
} from './ports/parent-relation.ts';
