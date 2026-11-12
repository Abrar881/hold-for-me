/**
 * Relative-date types and resolution utilities.
 *
 * All arithmetic is done against UTC date-only values so the host timezone
 * never shifts days.  Time strings (HH:MM) are appended verbatim.
 */

/** A moment described relative to a future ISO week (Mon-start). */
export interface RelTime {
  /** 0 = the ISO week that contains today, 1 = next week, etc. */
  weekOffset: number;
  /** ISO weekday: 1 = Mon … 7 = Sun */
  weekday: number;
  /** Local time, e.g. "09:00" */
  time: string;
}

/** Parse a YYYY-MM-DD string into a UTC midnight Date. */
function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a UTC Date as YYYY-MM-DD. */
function fmtDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Return the UTC Date of the ISO Monday of the week containing `today`. */
function isoWeekMonday(today: string): Date {
  const date = parseDate(today);
  // getUTCDay(): 0=Sun, 1=Mon … 6=Sat  →  ISO: Sun becomes 7
  const dow = date.getUTCDay();
  const isoDow = dow === 0 ? 7 : dow; // Mon=1 … Sun=7
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (isoDow - 1));
  return monday;
}

/**
 * Resolve a RelTime to a "YYYY-MM-DDTHH:MM" string.
 * @param r   Relative time descriptor
 * @param today  Current date as YYYY-MM-DD (use TODAY env or system date)
 */
export function resolveRel(r: RelTime, today: string): string {
  const monday = isoWeekMonday(today);
  // Advance by weekOffset weeks
  monday.setUTCDate(monday.getUTCDate() + r.weekOffset * 7);
  // Advance by (weekday - 1) days (Mon=1 → +0, Tue=2 → +1, …)
  monday.setUTCDate(monday.getUTCDate() + (r.weekday - 1));
  return `${fmtDate(monday)}T${r.time}`;
}

/**
 * Return the Monday-to-Sunday date range for the ISO week at `weekOffset`
 * relative to `today`.
 */
export function weekRange(weekOffset: number, today: string): { from: string; to: string } {
  const monday = isoWeekMonday(today);
  monday.setUTCDate(monday.getUTCDate() + weekOffset * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: fmtDate(monday), to: fmtDate(sunday) };
}

/**
 * Return the ISO weekday number (1=Mon … 7=Sun) for a YYYY-MM-DD string.
 */
export function weekdayOf(date: string): number {
  const d = parseDate(date);
  const dow = d.getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}
