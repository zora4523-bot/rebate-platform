/** The instant's calendar date at the fixed offset +08:00, formatted YYYY-MM-DD. */
export function accountingDate(at: Date): string {
  void at;
  throw new Error('NotImplemented: accountingDate');
}

/** The instant's calendar month at the fixed offset +08:00, formatted YYYY-MM. */
export function chinaMonth(at: Date): string {
  void at;
  throw new Error('NotImplemented: chinaMonth');
}

/** Strict YYYY-MM-DD input; [start, end) uses YYYY-MM-DDT00:00:00+08:00 strings. */
export function chinaDayRange(date: string): { start: string; end: string } {
  void date;
  throw new Error('NotImplemented: chinaDayRange');
}

/** Strict YYYY-MM input; [start, end) uses YYYY-MM-DDT00:00:00+08:00 strings. */
export function chinaMonthRange(month: string): { start: string; end: string } {
  void month;
  throw new Error('NotImplemented: chinaMonthRange');
}
