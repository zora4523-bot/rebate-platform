// Month-partition naming and scheduling helpers. Pure functions; all month arithmetic is UTC.
// The naming rule must stay in sync with app.ensure_month_partition (db/migrations).

/** Tables partitioned by month (ADR-0001 §4.2 #5). Mirrors the allow-list in the SQL function. */
export const MONTH_PARTITIONED_TABLES = ['event_log'] as const;

export type MonthPartitionedTable = (typeof MONTH_PARTITIONED_TABLES)[number];

/** How many future months are created ahead of time (ADR-0001 §4.2 #4). */
export const MONTHS_AHEAD = 3;

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError(`${name} is not a valid date`);
  }
}

/** First instant (UTC) of the month that contains `instant`. */
export function utcMonthStart(instant: Date): Date {
  assertValidDate(instant, 'instant');
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
}

/** `YYYY-MM-01` of the UTC month that contains `instant`; the `p_month` argument in SQL. */
export function monthStartDate(instant: Date): string {
  const start = utcMonthStart(instant);
  const year = String(start.getUTCFullYear()).padStart(4, '0');
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/** Partition name for the UTC month that contains `month`, e.g. `event_log_p202610`. */
export function monthPartitionName(table: string, month: Date): string {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) {
    throw new RangeError(`invalid table name: ${JSON.stringify(table)}`);
  }
  const date = monthStartDate(month);
  return `${table}_p${date.slice(0, 4)}${date.slice(5, 7)}`;
}

/**
 * UTC month starts to keep in place: the month containing `now` plus `ahead` following months,
 * in ascending order.
 */
export function monthsToEnsure(now: Date, ahead: number): Date[] {
  if (!Number.isInteger(ahead) || ahead < 0) {
    throw new RangeError(`ahead must be a non-negative integer, got ${String(ahead)}`);
  }
  const first = utcMonthStart(now);
  const months: Date[] = [];
  for (let i = 0; i <= ahead; i += 1) {
    months.push(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1)));
  }
  return months;
}
