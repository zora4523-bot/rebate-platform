// Growth's current parent-relation reader (B1-11n), for the content pages module's has_parent
// audience condition (F1-09g):
// - one query on app.users by (app_id, id); no row (including the same id under another app_id)
//   → null.
// - has_parent is parent_id IS NOT NULL (BR-INV-11: parent_id is the only authority). A row with
//   no parent but a stored parent_bound_at is projected as { false, null }; nothing is repaired.
// - the parent's identity is never selected or returned: the result has exactly two keys.
// - users.status and risk state are not filtered; read-only, uncached, reads no configuration; a
//   database error propagates unchanged.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
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
  const { db } = options;
  return {
    async relationOf(subject) {
      const row = await db
        .selectFrom('users')
        .select(['parent_id', 'parent_bound_at'])
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      // Build a fresh two-key object: parent_id stays inside this function.
      const hasParent = row.parent_id !== null;
      return { has_parent: hasParent, parent_bound_at: hasParent ? row.parent_bound_at : null };
    },
  };
}
