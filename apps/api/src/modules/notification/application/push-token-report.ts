// B1-12c: POST /v1/devices/push-token (contract reportPushToken) — the token report use case
// (规划/08 BR-ID-07 细则「推送令牌与会话」: 令牌值去重、归属、冲突冻结、上报时只接受当前会话).
// notification is the only writer of push_tokens. The rule tests in
// test/spec/notification/push-token-report/** import this file by path; the names, signatures and
// the semantics written here are the contract. SKELETON: every function throws NotImplemented.
//
// createPushTokenReporter(options).report(command) — one transaction per report; resolves (void)
// in every rule outcome (written, ignored, refused, frozen): the route always answers success.
//   0. Every query carries command.app_id. Time only from options.clock (one `now` per report).
//   1. Current session only: lock the device row (app_id, device_id) first; when its
//      last_login_sid is not command.sid → ignore the whole report (no write at all: no token
//      value, no binding, no row created). Reading last_login_sid and writing the token rows happen
//      in that one transaction, never read-then-write; then lock the token rows involved in id order.
//   2. The device's own row (app_id, device_id, provider) frozen (frozen_until > now) → no write.
//      The live row holding (app_id, provider, token) on another device frozen → no write.
//   3. Value not live on another device row:
//      - no own row → insert (user_id, bound_sid) = (command.user_id, command.sid), token_set_at =
//        now, acquired_by_move_at = null, frozen_until = null, revoked_at = null;
//      - own row with the same value → token_set_at unchanged; only (user_id, bound_sid) = current;
//      - own row with another value (or revoked) → token = value, token_set_at = now,
//        acquired_by_move_at = null, revoked_at = null, binding = current.
//   4. Value live on another device row (the holder) — devices.created_at decides:
//      - reporter registered later: holder.acquired_by_move_at > now − window → FREEZE: holder
//        frozen_until = now + window, user_id / bound_sid = null, token stays; the reporter's row is
//        not written; exactly one warn log with code 'PUSH_TOKEN_CONFLICT' (both device ids and
//        the flat field token_fingerprint, never the token value). Otherwise MIGRATE (below).
//      - reporter registered earlier: RECLAIM only when the request's session (sessions.created_at
//        of command.sid) is strictly later than holder.token_set_at (no window check); otherwise
//        REFUSE: no write, exactly one log line naming both device ids, with token_fingerprint.
//      - token_fingerprint: a non-empty string, deterministic per token value (same value → same
//        fingerprint, different values → different), never containing the token value
//        (e.g. a sha256 hex prefix).
//      - MIGRATE / RECLAIM: in the transaction, holder revoked_at = now, user_id / bound_sid = null;
//        then the reporter's row (inserted, or updated and restored when revoked) gets token =
//        value, token_set_at = now, acquired_by_move_at = now, binding = current, revoked_at = null.
//   5. window = config `push.token_conflict_window_hours` of command.app_id (a positive integer,
//      in hours); missing or not a positive integer → 24.
//   6. Concurrency: the partial unique (app_id, provider, token) WHERE revoked_at IS NULL is the
//      backstop; on 23505 re-read and judge again in the same transaction, a bounded number of times
//      (a SAVEPOINT around the write keeps the transaction usable).
//   7. Holder revocation and the acquiring row's write are in one transaction: a failure of the
//      second write leaves both rows as they were before the request (and the report rejects).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';

/** One report: the subject is the verified token principal, the value is the request body. */
export interface PushTokenReport {
  readonly app_id: string;
  readonly user_id: string;
  readonly sid: string;
  readonly device_id: string;
  readonly provider: string;
  readonly token: string;
}

/** content's configValue port shape (createContentReader satisfies it). */
export interface PushTokenConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

export interface PushTokenReporterOptions {
  /** Business handle (schema app, as createDb returns it). */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly config: PushTokenConfigReader;
}

export interface PushTokenReporter {
  /** Resolves in every rule outcome; rejects only on an infrastructure failure. */
  report(command: PushTokenReport): Promise<void>;
}

export function createPushTokenReporter(options: PushTokenReporterOptions): PushTokenReporter {
  void options;
  throw new Error('NotImplemented: createPushTokenReporter');
}
