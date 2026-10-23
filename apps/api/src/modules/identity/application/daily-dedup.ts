// Alarm lines at most once per key and +08:00 day in this process (task B1-15f brief §9.2 #6,
// shared with B1-15g's processing round): the set is cleared when the day changes; several
// replicas or a restart may report again (accepted).
//
// Also compiled by the `test` project: erasable syntax only.
const DAY_MS = 86_400_000;
/** +08:00 (China Standard Time, no daylight saving): the alarm dedup's day boundary. */
const OFFSET_MS = 8 * 3_600_000;

/** Day number of the +08:00 civil date of `at`. */
function localDay(at: Date): number {
  return Math.floor((at.getTime() + OFFSET_MS) / DAY_MS);
}

export interface DailyDedup {
  /** True the first time `key` is met on the +08:00 day of `now`. */
  first(key: string, now: Date): boolean;
}

export function createDailyDedup(): DailyDedup {
  let day: number | undefined;
  const seen = new Set<string>();
  return {
    first(key: string, now: Date): boolean {
      const today = localDay(now);
      if (day !== today) {
        day = today;
        seen.clear();
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}
