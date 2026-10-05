import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

// Structural match to platform/audit/port.ts, checked by the rule tests. The test phase
// cannot add its export to platform/index.ts; implementation may then import that type.
export interface AdminAuditInput {
  readonly appId: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: DB['audit_logs']['before'];
  readonly after: DB['audit_logs']['after'];
  readonly ip: string | null;
}

/** Pure, node-runnable factory: no Nest runtime imports; append inserts app.audit_logs. */
export function createAuditWriter(deps: { db: Kysely<DB>; clock: Clock }): {
  append(input: AdminAuditInput): Promise<void>;
} {
  void deps;
  throw new Error('NotImplemented: createAuditWriter');
}
