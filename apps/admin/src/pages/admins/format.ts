// Time display for the admin accounts list: always Beijing time (+08:00), never the runtime's
// local time zone.
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijing(iso: string): Date | undefined {
  const ms = Date.parse(iso);
  // Shifted so the UTC getters read Beijing wall-clock fields.
  return Number.isNaN(ms) ? undefined : new Date(ms + BEIJING_OFFSET_MS);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD in Beijing time; unreadable input is shown as is. */
export function formatBeijingDate(iso: string): string {
  const date = beijing(iso);
  if (date === undefined) return iso;
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** HH:mm in Beijing time; unreadable input is shown as is. */
export function formatBeijingTime(iso: string): string {
  const date = beijing(iso);
  if (date === undefined) return iso;
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** Locked only while locked_until is strictly later than now (equal means unlocked). */
export function isLocked(lockedUntil: string | null | undefined, now: Date): boolean {
  if (lockedUntil === null || lockedUntil === undefined) return false;
  const ms = Date.parse(lockedUntil);
  return !Number.isNaN(ms) && ms > now.getTime();
}
