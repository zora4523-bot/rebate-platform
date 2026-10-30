// B2-02s (FU-B202R-DONE-MARK): the durable completion record of the daily ledger check (08
// BR-FUND-19 每日 01:00 +08:00 对会计日 D−1 运行; task brief §9.2). When the `daily` handler of
// (app, D) has run to the end (the runner and the B2-02p execution step), it writes one row of
// app.processed_events — consumer 'ledger.daily_check_done', event_id dailyCheckDoneEventId(app, D),
// INSERT … ON CONFLICT DO NOTHING — on the same transaction that enqueues D+1. A run that throws
// before that writes nothing (the transaction rolls back). The run store's stateOf reports an
// (app, D) with that row as 'done' even when the queue holds only failed / dead-lettered jobs of
// its key (an attempt judged failed after expireInSeconds although its work had finished), so the
// heal neither re-sends nor alerts a finished day.
//
// Skeleton only (rule-test round): the implementation comes with the implementer's round.

/** The processed_events consumer of the completion record of (app, D). */
export type DailyCheckDoneConsumer = 'ledger.daily_check_done';

/**
 * The event_id (a uuid) of the completion record of (app, D): derived from app_id and D only, the
 * same in every process and after a restart; different for every other (app, D).
 */
export function dailyCheckDoneEventId(appId: string, accountingDate: string): string {
  void appId;
  void accountingDate;
  throw new Error('NotImplemented: dailyCheckDoneEventId');
}
