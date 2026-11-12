/**
 * Calendar clash detection, ICS export, and booking persistence.
 *
 * All datetime comparisons are lexicographic (YYYY-MM-DDTHH:MM strings
 * sort correctly as strings), so no Date objects are needed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Slot, CalendarEvent, Booking } from '../shared/types.js';

/**
 * Returns true if the two half-open intervals [a.start, a.end) and
 * [b.start, b.end) overlap.  Back-to-back intervals (a.end === b.start)
 * do NOT overlap.
 */
export function overlaps(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Returns the subset of events that overlap with the given slot. */
export function clashes(slot: Slot, events: CalendarEvent[]): CalendarEvent[] {
  return events.filter(e => overlaps(slot, e));
}

/**
 * Returns events whose start date falls within [from, to] inclusive.
 * `from` and `to` are YYYY-MM-DD strings.
 */
export function busyBetween(
  events: CalendarEvent[],
  from: string,
  to: string,
): CalendarEvent[] {
  return events.filter(e => {
    const date = e.start.slice(0, 10);
    return date >= from && date <= to;
  });
}

/**
 * Appends a booking to `<dir>/calendar.bookings.json`.
 * Creates the file (as a JSON array) if it does not yet exist.
 */
export function appendBooking(dir: string, booking: Booking): void {
  const filePath = path.join(dir, 'calendar.bookings.json');
  let bookings: Booking[] = [];
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    bookings = JSON.parse(raw) as Booking[];
  }
  bookings.push(booking);
  fs.writeFileSync(filePath, JSON.stringify(bookings, null, 2), 'utf-8');
}

/** Convert "YYYY-MM-DDTHH:MM" to ICS datetime "YYYYMMDDTHHmmss" (floating local time). */
function toIcsDateTime(dt: string): string {
  const [date, time] = dt.split('T');
  const dateStr = date.replace(/-/g, '');
  const timeStr = time.replace(':', '') + '00';
  return `${dateStr}T${timeStr}`;
}

/**
 * Generates a minimal VCALENDAR ICS string for a confirmed booking.
 * Uses floating local time (no Z suffix) and CRLF line endings per RFC 5545.
 */
export function toIcs(booking: Booking, profileName: string): string {
  const dtstart = toIcsDateTime(booking.start);
  const dtend   = toIcsDateTime(booking.end);
  const uid     = `${booking.slotId}@hold-for-me`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hold For Me//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${booking.clinicName} appointment`,
    `DESCRIPTION:Patient: ${profileName}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];

  return lines.join('\r\n');
}
