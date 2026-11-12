import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clashes, busyBetween, toIcs, appendBooking } from '../src/server/calendar.js';
import { loadCalendar } from '../src/server/data.js';
import type { Slot, CalendarEvent, Booking } from '../src/shared/types.js';

const TODAY = '2026-11-12';

const STAND_UP: CalendarEvent = {
  title: 'Team stand-up',
  start: '2026-11-17T09:00',
  end: '2026-11-17T10:00',
};

const BOOKING: Booking = {
  clinicId: 'bright-smile',
  clinicName: 'Bright Smile Dental',
  slotId: 'bs-1',
  start: '2026-11-19T10:30',
  end: '2026-11-19T11:00',
};

describe('clashes', () => {
  it('back-to-back is not a clash', () => {
    const slot: Slot = { slotId: 'x', start: '2026-11-17T10:00', end: '2026-11-17T10:30' };
    const event: CalendarEvent = { title: 'prev', start: '2026-11-17T09:00', end: '2026-11-17T10:00' };
    expect(clashes(slot, [event])).toEqual([]);
  });

  it('partial overlap clashes', () => {
    const slot: Slot = { slotId: 'x', start: '2026-11-17T09:30', end: '2026-11-17T10:00' };
    expect(clashes(slot, [STAND_UP])).toHaveLength(1);
  });
});

describe('busyBetween', () => {
  it('filters by date range inclusive', () => {
    const events: CalendarEvent[] = [
      { title: 'Before', start: '2026-11-16T09:00', end: '2026-11-16T10:00' },
      STAND_UP,
      { title: 'C', start: '2026-11-18T09:00', end: '2026-11-18T10:00' },
      { title: 'After', start: '2026-11-19T09:00', end: '2026-11-19T10:00' },
    ];
    const result = busyBetween(events, '2026-11-17', '2026-11-18');
    expect(result).toHaveLength(2);
    expect(result.map(e => e.title)).toContain('Team stand-up');
    expect(result.map(e => e.title)).toContain('C');
  });
});

describe('toIcs', () => {
  it('contains DTSTART:20261119T103000 and SUMMARY with clinic name', () => {
    const ics = toIcs(BOOKING, 'Alex Khan');
    expect(ics).toContain('DTSTART:20261119T103000');
    expect(ics).toContain('SUMMARY:Bright Smile Dental appointment');
  });

  it('uses CRLF line endings', () => {
    const ics = toIcs(BOOKING, 'Alex Khan');
    expect(ics).toContain('\r\n');
  });
});

describe('appendBooking + loadCalendar', () => {
  it('appendBooking then loadCalendar includes booking', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiya-cal-'));
    try {
      // calendar.json must be present (empty array is valid)
      fs.writeFileSync(path.join(tmpDir, 'calendar.json'), '[]', 'utf-8');
      appendBooking(tmpDir, BOOKING);
      const events = loadCalendar(tmpDir, TODAY);
      const found = events.find(e => e.title === 'Bright Smile Dental appointment');
      expect(found).toBeDefined();
      expect(found!.start).toBe('2026-11-19T10:30');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
