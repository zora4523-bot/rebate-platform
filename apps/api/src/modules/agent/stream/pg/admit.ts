import { sql } from 'kysely';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  dayKeyOf,
  nextResetAt,
  nextStepOf,
  subjectKeys,
} from '../admission/index.ts';
import type { AdmissionLimits, AdmissionRequest, AdmissionResult } from '../admission/index.ts';
import type { PgRunDeps } from './types.ts';
import { fromStored } from './frames.ts';
import { holdFailure } from './finalize.ts';
import type { Finalization } from './finalize.ts';
import {
  dailyUsage,
  isRunning,
  lockSession,
  lockSubjects,
  readRun,
  remaining,
  subjectLimits,
} from './store.ts';
import type { RunRow, SessionRow } from './store.ts';
import { errorCode, TransactionFailure, unavailable } from './transaction.ts';
import type { Queries, Transactions } from './transaction.ts';

export function createAdmission(
  deps: PgRunDeps,
  transaction: Transactions,
  finalization: Finalization,
) {
  async function messageRun(q: Queries, session: SessionRow, clientMsgId: string) {
    return (
      await q.query(sql<{ run_id: string; id: string }>`SELECT run_id, id FROM app.agent_messages
      WHERE app_id = ${session.app_id} AND session_id = ${session.id}
      AND client_msg_id = ${clientMsgId} AND role = 'user'`)
    )[0];
  }

  async function accept(
    q: Queries,
    req: AdmissionRequest,
    limits: AdmissionLimits,
  ): Promise<AdmissionResult> {
    const session = await lockSession(q, req.sessionId);
    const now = deps.clock.now();
    if (
      !session ||
      session.last_active_at.getTime() + 86_400_000 <= now.getTime() ||
      (session.expired_at !== null && session.expired_at.getTime() <= now.getTime())
    ) {
      return { kind: 'rejected', code: 30504, reason: 'expired' };
    }
    const appId = session.app_id;
    const duplicate = await messageRun(q, session, req.clientMsgId);
    if (duplicate) {
      const run = await readRun(q, duplicate.run_id, true);
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      const assistant = (
        await q.query(sql<{ id: string }>`SELECT id FROM app.agent_messages
        WHERE app_id = ${appId} AND run_id = ${run.id} AND role = 'assistant'`)
      )[0];
      if (!assistant) throw new Error('Agent assistant message missing');
      const original = {
        runId: run.id,
        userMessageId: duplicate.id,
        assistantMessageId: assistant.id,
        promptVersion: run.prompt_version,
        modelSnapshot: run.model_snapshot,
      };
      if (run.final_event !== null) {
        return {
          kind: 'duplicate',
          original,
          reply: { kind: 'final', frame: fromStored(run.final_event, 'final') },
        };
      }
      if (isRunning(session, run.id, now))
        return { kind: 'duplicate', original, reply: { kind: 'running' } };
      await lockSubjects(q, appId, run.quota_subjects);
      const out = await finalization.finalizeRun(q, session, run, now, limits);
      if (out.kind === 'held') throw new AdmissionHeldError(out.reason);
      if (out.kind !== 'final') throw new Error('Unfinished duplicate');
      return { kind: 'duplicate', original, reply: { kind: 'final', frame: out.frame } };
    }

    const leftovers: RunRow[] = [];
    if (session.run_lock_run_id !== null) {
      const run = await readRun(q, session.run_lock_run_id, true);
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      if (isRunning(session, run.id, now)) return { kind: 'rejected', code: 30506 };
      leftovers.push(run);
    }
    const others = await q.query(sql<RunRow>`SELECT * FROM app.agent_runs
      WHERE app_id = ${appId} AND session_id = ${session.id} AND final_event IS NULL
      ${session.run_lock_run_id === null ? sql`` : sql`AND id <> ${session.run_lock_run_id}`}
      ORDER BY id FOR UPDATE`);
    for (const run of others) {
      if (run.finalize_hold !== null) throw new AdmissionHeldError(run.finalize_hold);
      leftovers.push(run);
    }
    const subjects = subjectKeys(req.subject);
    await lockSubjects(q, appId, [...subjects, ...leftovers.flatMap((run) => run.quota_subjects)]);
    for (const run of leftovers) {
      const out = await finalization.finalizeRun(q, session, run, now, limits);
      if (out.kind === 'held') throw new AdmissionHeldError(out.reason);
    }
    const window = (
      await q.query(sql<{ count: string; oldest: Date | null }>`SELECT count(*)::text AS count,
      min(accepted_at) AS oldest FROM app.agent_runs WHERE app_id = ${appId}
      AND quota_subjects[1] = ${subjects[0]} AND accepted_at > ${instantPlus(now, -60_000)}`)
    )[0]!;
    if (Number(window.count) >= limits.perMinute) {
      return {
        kind: 'rejected',
        code: 42901,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((window.oldest?.getTime() ?? now.getTime()) + 60_000 - now.getTime()) / 1_000),
        ),
      };
    }
    const rounds = (
      await q.query(sql<{ count: string }>`SELECT count(*)::text AS count FROM app.agent_runs
      WHERE app_id = ${appId} AND session_id = ${session.id}`)
    )[0]!;
    if (Number(rounds.count) >= limits.maxRounds)
      return { kind: 'rejected', code: 30504, reason: 'round_limit' };
    const counts = await dailyUsage(q, appId, subjects, now);
    if (subjectLimits(subjects, limits).some((limit, index) => counts[index]! >= limit)) {
      return {
        kind: 'rejected',
        code: 30502,
        resetAt: nextResetAt(now),
        next: nextStepOf(req.subject),
      };
    }
    const deadline = instantPlus(now, deps.timings.runMaxMs);
    const lockEnd = instantPlus(deadline, deps.timings.lockGraceMs);
    await q.query(sql`INSERT INTO app.agent_runs
      (id, app_id, session_id, user_text, prompt_version, model_snapshot, accepted_at, quota_subjects,
        deadline_at, created_at, updated_at)
      VALUES (${req.runId}, ${appId}, ${session.id}, ${req.reply.runUserText}, ${req.reply.promptVersion},
        ${req.reply.modelSnapshot}, ${now}, ${subjects}::text[], ${deadline}, ${now}, ${now})`);
    await q.query(sql`INSERT INTO app.agent_messages
      (id, app_id, session_id, run_id, role, client_msg_id, text, created_at, updated_at) VALUES
      (${req.messageId}, ${appId}, ${session.id}, ${req.runId}, 'user', ${req.clientMsgId}, ${req.reply.messageText}, ${now}, ${now}),
      (${req.reply.assistantMessageId}, ${appId}, ${session.id}, ${req.runId}, 'assistant', NULL, NULL, ${now}, ${now})`);
    await q.query(sql`UPDATE app.agent_sessions SET last_active_at = GREATEST(last_active_at, ${now}),
      run_lock_run_id = ${req.runId}, run_lock_expires_at = ${lockEnd}, row_version = row_version + 1, updated_at = ${now}
      WHERE app_id = ${appId} AND id = ${session.id}`);
    return {
      kind: 'accepted',
      ticket: {
        runId: req.runId,
        messageId: req.messageId,
        sessionId: session.id,
        subject: structuredClone(req.subject),
        dayKey: dayKeyOf(now),
        acceptedAtMs: now.getTime(),
        lockExpiresAtMs: lockEnd.getTime(),
      },
      quotaLeft: remaining(
        subjects,
        limits,
        counts.map((count) => count + 1),
      ),
    };
  }

  return async function admit(
    req: AdmissionRequest,
    limits: AdmissionLimits,
  ): Promise<AdmissionResult> {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Invalid admission limit');
    }
    for (let attempt = 0; ; attempt += 1) {
      let answer: AdmissionResult | undefined;
      try {
        return await transaction('admit', async (q) => {
          answer = await accept(q, req, limits);
          return answer;
        });
      } catch (error) {
        const hold = holdFailure(error);
        if (hold) {
          await finalization.markHold(hold);
          throw new AdmissionHeldError(hold.reason);
        }
        if (error instanceof TransactionFailure && error.original instanceof AdmissionHeldError)
          throw error.original;
        if (error instanceof TransactionFailure && error.commitAttempted) {
          if (answer?.kind === 'rejected') return answer;
          // A duplicate's inline finalization must be confirmed before replaying its frame.
          if (answer?.kind !== 'accepted') throw new AdmissionUnavailableError('unknown');
          let found: string | undefined;
          try {
            found = await transaction('lookup', async (q) => {
              const session = await lockSession(q, req.sessionId);
              return session ? (await messageRun(q, session, req.clientMsgId))?.run_id : undefined;
            });
          } catch {
            deps.logger?.warn({ run_id: req.runId }, 'agent.accept_outcome_unknown');
            throw new AdmissionUnavailableError('unknown');
          }
          if (found === req.runId) return answer;
          if (found !== undefined && attempt === 0) continue;
          throw new AdmissionUnavailableError('rolled_back');
        }
        if (
          attempt === 0 &&
          errorCode(error) === '23505' &&
          error instanceof TransactionFailure &&
          typeof error.original === 'object' &&
          error.original !== null &&
          'constraint' in error.original &&
          error.original.constraint === 'agent_messages_client_msg_key'
        )
          continue;
        return unavailable(error);
      }
    }
  };
}

/** Derive another instant from the one Clock reading, without mutating it. */
function instantPlus(instant: Date, milliseconds: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + milliseconds);
  return result;
}
