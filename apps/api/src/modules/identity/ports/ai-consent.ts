// Identity's AI consent reader (规划/08 BR-AI-13; current-state rule BR-ID-12). The agent module asks
// it before any /v1/agent/* call whether the subject may use the AI service:
// - subject: a logged-in user (userId set) reads only user-level records of that user_id; a guest
//   (userId null) reads only device-level records of that device_id. No fallback either way: a
//   guest's device consent is not inherited after login, and a user-level record never counts for
//   a guest on the same device.
// - current state: among that subject's type=ai_third_party records in the app, the one with the
//   latest server_at, then the largest id (as currentStates in domain/login.ts).
// - verdict: none → missing; accepted=false → withdrawn (checked before the version); version not
//   equal to the injected current AgentConsent version (lower or higher) → outdated; else allowed.
// The current version comes from the injected source on every call (per appId, never cached); a
// rejection or a value that is not a positive safe integer makes check() reject, as does a
// database error: neither is ever turned into a business verdict. Read-only.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AiConsentSubject {
  appId: string;
  userId: string | null;
  deviceId: string;
}

export type AiConsentVerdict =
  | { allowed: true; version: number }
  | { allowed: false; reason: 'missing' | 'withdrawn' | 'outdated' };

export interface AiConsentReader {
  check(subject: AiConsentSubject): Promise<AiConsentVerdict>;
}

export interface AiConsentReaderOptions {
  db: Kysely<DB>;
  currentVersion: (appId: string) => Promise<number>;
}

function validVersion(appId: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid current AgentConsent version for app ${appId}`);
  }
  return value;
}

export function createAiConsentReader(options: AiConsentReaderOptions): AiConsentReader {
  const { db, currentVersion } = options;
  return {
    async check(subject) {
      const { appId, userId, deviceId } = subject;
      const version = validVersion(appId, await currentVersion(appId));
      let query = db
        .selectFrom('consent_records')
        .select(['accepted', 'version'])
        .where('app_id', '=', appId)
        .where('type', '=', 'ai_third_party');
      query =
        userId === null
          ? query.where('subject_type', '=', 'device').where('device_id', '=', deviceId)
          : query.where('subject_type', '=', 'user').where('user_id', '=', userId);
      const latest = await query
        .orderBy('server_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (latest === undefined) return { allowed: false, reason: 'missing' };
      if (!latest.accepted) return { allowed: false, reason: 'withdrawn' };
      if (latest.version !== version) return { allowed: false, reason: 'outdated' };
      return { allowed: true, version };
    },
  };
}
