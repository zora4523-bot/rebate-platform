import { sql } from 'kysely';
import type { RunEnding } from '../admission/index.ts';
import type { RunFacts, RunTexts, TerminalDraft } from '../run/types.ts';
import { toStored } from './frames.ts';
import { readRun } from './store.ts';
import type { RunRow } from './store.ts';
import type { Queries } from './transaction.ts';

export interface EndingMemo {
  readonly facts: RunFacts;
  readonly draft: TerminalDraft;
}

export function defaultDraft(ending: RunEnding, texts: Pick<RunTexts, 'errorMsg'>): TerminalDraft {
  const error = (code: number, retryable: boolean): TerminalDraft => ({
    event: 'error',
    data: { code, msg: texts.errorMsg(code), retryable, fallback: null },
  });
  switch (ending) {
    case 'server_error':
      return error(50001, true);
    case 'consent_withdrawn':
      return error(10004, false);
    case 'disabled':
      return error(30501, false);
    case 'client_error':
      return error(30503, false);
    case 'disconnected':
      return { event: 'done', data: { finish_reason: 'cancelled' } };
    case 'input_review_timeout':
      return { event: 'done', data: { finish_reason: 'error' } };
    default:
      return { event: 'done', data: { finish_reason: ending } };
  }
}

/** The only ending writer: cancellation already committed on this row wins. */
export async function decideEnding(q: Queries, runId: string, memo: EndingMemo): Promise<RunRow> {
  const cancelled: TerminalDraft = { event: 'done', data: { finish_reason: 'cancelled' } };
  const rows = await q.query(sql<RunRow>`UPDATE app.agent_runs SET
    end_reason = CASE WHEN cancel_requested_at IS NULL THEN ${memo.facts.ending} ELSE 'cancelled' END,
    end_draft = CASE WHEN cancel_requested_at IS NULL THEN ${JSON.stringify(toStored(memo.draft))}::jsonb
      ELSE ${JSON.stringify(toStored(cancelled))}::jsonb END,
    card_delivered = card_delivered OR ${memo.facts.cardsDelivered > 0}
    WHERE id = ${runId} AND end_reason IS NULL RETURNING *`);
  return rows[0] ?? readRun(q, runId);
}
