/** The instant's calendar date at the fixed offset +08:00, formatted YYYY-MM-DD. */
export function chinaDate(at: Date): string {
  void at;
  throw new Error('NotImplemented: chinaDate');
}

/** The instant's calendar month at the fixed offset +08:00, formatted YYYY-MM. */
export function chinaMonth(at: Date): string {
  void at;
  throw new Error('NotImplemented: chinaMonth');
}

/** Strict YYYY-MM-DD input; returns the +08:00 day as [start, end). */
export function chinaDayRange(date: string): { start: Date; end: Date } {
  void date;
  throw new Error('NotImplemented: chinaDayRange');
}

/** Strict YYYY-MM input; returns the +08:00 calendar month as [start, end). */
export function chinaMonthRange(month: string): { start: Date; end: Date } {
  void month;
  throw new Error('NotImplemented: chinaMonthRange');
}
