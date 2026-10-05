// Audit write port (BR-ID-34: every admin write is audited; 04 §3.2: audit_logs is insert-only,
// its single writer is the admin module). The port lives in platform so that any module can
// depend on it without importing admin (admin depends on every module, 规划/02 §4.1; a business
// module importing admin would close a cycle). The admin module implements it and provides it
// globally under `AUDIT_PORT`.
//
// Pure module: type-only imports and a plain symbol, runnable by node directly.
import type { DB } from '@couli/db';

/**
 * One audit event. `actor` is admin_users.id. There is deliberately no `at`: the writer stamps
 * every row from its injected Clock, so a caller cannot back- or forward-date an entry.
 * Sensitive values in `before` / `after` must be masked by the caller (BR-ID-33); the admin
 * writer additionally discards values under known sensitive key names.
 */
export interface AuditInput {
  readonly appId: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly before: DB['audit_logs']['before'];
  readonly after: DB['audit_logs']['after'];
  readonly ip: string | null;
}

/** Append-only capability: no update, no delete. */
export interface AuditPort {
  append(input: AuditInput): Promise<void>;
}

/** Nest injection token for `AuditPort`; provided globally by the admin module. */
export const AUDIT_PORT = Symbol('AUDIT_PORT');
