import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface ParentRelationSubject {
  appId: string;
  userId: string;
}

export interface ParentRelation {
  has_parent: boolean;
  parent_bound_at: Date | null;
}

export interface ParentRelationReader {
  relationOf(subject: ParentRelationSubject): Promise<ParentRelation | null>;
}

export interface ParentRelationReaderOptions {
  db: Kysely<DB>;
}

/** B1-11n: current relation only; read-only, uncached, no parent identity or configuration. */
export function createParentRelationReader(
  options: ParentRelationReaderOptions,
): ParentRelationReader {
  void options;
  throw new Error('NotImplemented: createParentRelationReader');
}
