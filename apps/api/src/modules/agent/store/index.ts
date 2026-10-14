// Session reads and writes of the Agent HTTP layer (B3-03d after the 2026-10-08 redesign; BR-AI-20;
// table app.agent_sessions, db/schema.sql). Acceptance, duplicates, the session run lock,
// finalization and the cancel write are B3-03g's (../stream/pg); this store only creates, finds and
// checks the ownership of sessions, and tells whether a run belongs to one of the caller's sessions.
// The rule tests in test/spec/agent/stream-http/** import this file by path: names, signatures
// and the semantics written here are the contract.
//
// Owner (BR-AI-20): kind 'user' (the caller has an access token) owns the sessions whose user_id is
// that user, on any device; kind 'device' (a guest) owns the sessions whose user_id IS NULL and
// whose device_id is that device. A user never falls back to the device's guest sessions, and a
// guest never sees a user's session even on the same device. Every query is scoped by app_id.
// Expired (BR-AI-20): last_active_at + deps.idleMs ≤ now, where now = deps.clock.now() read once
// per call (never the database clock); a set expired_at ≤ now is expired as well (the same test as
// the admission re-check in ../stream/pg).
//
// createPgAgentSessionStore({db, clock, idleMs}):
//   open(owner, newId) — createAgentSession: the owner's newest unexpired session while it has no
//     agent_runs row yet (no turn) is returned unchanged; otherwise a new row is inserted with id
//     newId, user_id (null for a device owner), device_id (the owner's device), started_at =
//     last_active_at = now. Writes nothing else (no run, no message).
//   current(owner) — getCurrentAgentSession: the owner's unexpired session with the greatest
//     last_active_at, or null. Read only.
//   owned(owner, sessionId) — BR-AI-23 ④: {session, expired} when the session exists and belongs to
//     the owner, otherwise null (missing and not owned are never told apart). An id that is not a
//     UUID is null, not an error. Read only; last_active_at is never touched here (only an
//     acceptance moves it, B3-03g).
//   ownsRun(owner, runId) — the cancel endpoint: true when an agent_runs row with this id is in a
//     session the owner owns (expired or not); false when the run does not exist, is not the
//     owner's, or the id is not a UUID. Read only.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from the injected Clock, data
// access only through Kysely on deps.db.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type AgentOwner =
  | {
      readonly kind: 'user';
      readonly appId: string;
      readonly userId: string;
      /** The device of the request; written as device_id when a session is created. */
      readonly deviceId: string;
    }
  | { readonly kind: 'device'; readonly appId: string; readonly deviceId: string };

export interface AgentSessionRow {
  readonly id: string;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
}

export interface OwnedSession {
  readonly session: AgentSessionRow;
  readonly expired: boolean;
}

export interface AgentSessionStore {
  open(owner: AgentOwner, newId: string): Promise<AgentSessionRow>;
  current(owner: AgentOwner): Promise<AgentSessionRow | null>;
  owned(owner: AgentOwner, sessionId: string): Promise<OwnedSession | null>;
  ownsRun(owner: AgentOwner, runId: string): Promise<boolean>;
}

export interface PgAgentSessionStoreDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** BR-AI-20 expiry after last_active_at (agentSessionDefaults().idleMs). */
  readonly idleMs: number;
}

/** BR-AI-20: idleMs is 24 hours. */
export function agentSessionDefaults(): { readonly idleMs: number } {
  throw new Error('NotImplemented: agentSessionDefaults');
}

export function createPgAgentSessionStore(deps: PgAgentSessionStoreDeps): AgentSessionStore {
  void deps;
  throw new Error('NotImplemented: createPgAgentSessionStore');
}
