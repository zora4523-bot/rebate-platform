// Identity's user level reader (B1-02u). The funds quoter asks it which user_level (规划/04 §2.5,
// contracts/enums/ops.yaml user_level: L1 / L2 / L3) a viewer has, to pick the rate tier:
// - one query on app.users by (app_id, id); no row (including the same id under another app_id)
//   → null. The guest default (L1, BR-CALC-20) is the caller's business, not this port's.
// - users.status and risk state are not filtered: a deleting, deleted or banned user's level is
//   returned as stored; whether to quote is the caller's decision.
// - a stored value outside the contract enum rejects (the message carries only that value) and is
//   never mapped to some level (funds fail closed); a database error propagates unchanged.
// Read-only, uncached, reads no configuration.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { user_level, type UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export type { UserLevel } from '@couli/contracts-ts';

export interface UserLevelSubject {
  appId: string;
  userId: string;
}

export interface UserLevelReader {
  levelOf(subject: UserLevelSubject): Promise<UserLevel | null>;
}

export interface UserLevelReaderOptions {
  db: Kysely<DB>;
}

const LEVELS: ReadonlySet<string> = new Set(user_level);

function isUserLevel(value: string): value is UserLevel {
  return LEVELS.has(value);
}

/** B1-02u: uncached, read-only users.level lookup; unknown stored levels must reject. */
export function createUserLevelReader(options: UserLevelReaderOptions): UserLevelReader {
  const { db } = options;
  return {
    async levelOf(subject) {
      const row = await db
        .selectFrom('users')
        .select('level')
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      if (!isUserLevel(row.level)) {
        throw new Error(
          `users.level holds a value outside user_level: ${JSON.stringify(row.level)}`,
        );
      }
      return row.level;
    },
  };
}
