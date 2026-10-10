/** B1-03i: dates are local civil dates in +08:00; the submission day is excluded. */
export interface AppealCalendarYear {
  readonly holidays: readonly string[];
  readonly makeupWorkdays: readonly string[];
}

export function appealDeadline(
  submittedAt: Date,
  calendars: Readonly<Record<number, AppealCalendarYear>>,
): Date {
  void submittedAt;
  void calendars;
  throw new Error('NotImplemented: appealDeadline');
}
