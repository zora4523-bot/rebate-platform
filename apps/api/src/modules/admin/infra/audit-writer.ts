// Admin implementation of the platform audit port: inserts app.audit_logs, nothing else
// (04 §3.2: audit_logs is insert-only, written only by admin; BR-ID-34).
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel):
// seed scripts and command-line tools can run it with node directly. The Nest provider is in
// ../admin.module.ts.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditInput, AuditPort, Clock } from '../../platform/index.ts';
import { redactSnapshot, type Snapshot } from './audit-redaction.ts';

/** Same shape as the platform port's input (kept for callers of the test-phase name). */
export type AdminAuditInput = AuditInput;

export interface AuditWriterDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /**
   * Extra exact key names whose values are replaced before insert, on top of the built-in
   * fragments of ./audit-redaction.ts (BR-ID-33 backstop; callers still mask). The backstop is
   * always on, also when this is omitted; the Nest provider adds platform logging's
   * SENSITIVE_KEYS.
   */
  readonly sensitiveKeys?: readonly string[];
}

/**
 * Returns an object whose only method is `append`. `at` always comes from `clock.now()` read
 * at each call; any extra property on the input (an `at`, an `id`) is ignored.
 */
export function createAuditWriter(deps: AuditWriterDeps): AuditPort {
  const { db, clock } = deps;
  const sensitive = deps.sensitiveKeys ?? [];
  const snapshot = (value: Snapshot | null) => {
    if (value === null) return null;
    const stored = redactSnapshot(value, sensitive);
    // Serialise explicitly: node-postgres would send a top-level array as a PG array literal.
    return sql<Snapshot>`${JSON.stringify(stored)}::jsonb`;
  };
  return {
    async append(input: AuditInput): Promise<void> {
      await db
        .insertInto('audit_logs')
        .values({
          app_id: input.appId,
          admin_id: input.actor,
          action: input.action,
          target: input.target,
          before: snapshot(input.before),
          after: snapshot(input.after),
          ip: input.ip,
          at: clock.now(),
        })
        .execute();
    },
  };
}
