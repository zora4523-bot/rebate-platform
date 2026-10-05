import type { DB } from '@couli/db';

/** F1-06b: actor is admin_users.id; at is supplied by the writer's Clock, never callers. */
export interface AuditInput {
  readonly appId: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: DB['audit_logs']['before'];
  readonly after: DB['audit_logs']['after'];
  readonly ip: string | null;
}

/** Append-only capability. Nest token/export/wiring belongs to the implementation phase. */
export class AuditPort {
  append(input: AuditInput): Promise<void> {
    void input;
    throw new Error('NotImplemented: AuditPort.append');
  }
}
