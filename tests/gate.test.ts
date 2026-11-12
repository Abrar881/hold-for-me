import { describe, it, expect } from 'vitest';
import { evaluateOffer } from '../src/server/gate.js';
import type { BookingRequest, Offer, CalendarEvent, Approval } from '../src/shared/types.js';

// Request: 2026-11-16 (Mon)..22 (Sun), 08:00–12:00, Wednesday excluded
const REQ: BookingRequest = {
  clinicId: 'test-clinic',
  service: 'consultation',
  patientName: 'Alice',
  dateFrom: '2026-11-16',
  dateTo: '2026-11-22',
  timeWindow: { start: '08:00', end: '12:00' },
  excludedWeekdays: [3], // 0=Sun..6=Sat → 3 = Wednesday
};

// Tuesday 09:00–10:00 — used for calendar clash tests
const STAND_UP: CalendarEvent = {
  title: 'Team stand-up',
  start: '2026-11-17T09:00',
  end: '2026-11-17T10:00',
};

function mkOffer(id: string, start: string, end: string, feeGbp?: number): Offer {
  return {
    offerId: id,
    slotId: `slot-${id}`,
    start,
    end,
    conditions: feeGbp !== undefined ? { feeGbp } : {},
  };
}

describe('evaluateOffer', () => {
  it('accepts in-window morning slot', () => {
    // Monday 2026-11-16, 09:00–10:00 — all conditions satisfied
    const offer = mkOffer('o1', '2026-11-16T09:00', '2026-11-16T10:00');
    expect(evaluateOffer(offer, REQ, [], [])).toEqual({ ok: true });
  });

  it('rejects Thu 15:00 as outside_time_window', () => {
    // Thursday 2026-11-19, 15:00–16:00 — end (16:00) > window end (12:00)
    const offer = mkOffer('o2', '2026-11-19T15:00', '2026-11-19T16:00');
    const result = evaluateOffer(offer, REQ, [], []);
    expect(result).toEqual({ ok: false, reasons: ['outside_time_window'] });
  });

  it('rejects Wednesday as excluded_day', () => {
    // Wednesday 2026-11-18, 09:00–10:00 — in time window but excluded weekday
    const offer = mkOffer('o3', '2026-11-18T09:00', '2026-11-18T10:00');
    const result = evaluateOffer(offer, REQ, [], []);
    expect(result).toEqual({ ok: false, reasons: ['excluded_day'] });
  });

  it('rejects clash with stand-up', () => {
    // Tuesday 2026-11-17, 09:30–10:30 — overlaps STAND_UP (09:00–10:00)
    const offer = mkOffer('o4', '2026-11-17T09:30', '2026-11-17T10:30');
    const result = evaluateOffer(offer, REQ, [STAND_UP], []);
    expect(result).toEqual({ ok: false, reasons: ['calendar_clash'] });
  });

  it('rejects unapproved £20 fee', () => {
    const offer = mkOffer('o5', '2026-11-16T09:00', '2026-11-16T10:00', 20);
    const result = evaluateOffer(offer, REQ, [], []);
    expect(result).toEqual({ ok: false, reasons: ['fee_unapproved'] });
  });

  it('accepts fee once approved', () => {
    const offer = mkOffer('o5', '2026-11-16T09:00', '2026-11-16T10:00', 20);
    const approval: Approval = { offerId: 'o5', kinds: ['fee'] };
    expect(evaluateOffer(offer, REQ, [], [approval])).toEqual({ ok: true });
  });

  it('slot approval waives time window but not calendar clash', () => {
    // Thursday 15:00–16:00 → outside time window
    // + a calendar clash on the same slot
    // → slot approval waives outside_time_window but calendar_clash remains
    const offer = mkOffer('o6', '2026-11-19T15:00', '2026-11-19T16:00');
    const clash: CalendarEvent = {
      title: 'Dentist check',
      start: '2026-11-19T14:30',
      end: '2026-11-19T15:30',
    };
    const approval: Approval = { offerId: 'o6', kinds: ['slot'] };
    const result = evaluateOffer(offer, REQ, [clash], [approval]);
    expect(result).toEqual({ ok: false, reasons: ['calendar_clash'] });
  });

  it('approval for a different offerId does not apply', () => {
    const offer = mkOffer('o7', '2026-11-16T09:00', '2026-11-16T10:00', 20);
    const approval: Approval = { offerId: 'other-offer', kinds: ['fee'] };
    const result = evaluateOffer(offer, REQ, [], [approval]);
    expect(result).toEqual({ ok: false, reasons: ['fee_unapproved'] });
  });

  it('unknown offer returns unknown_offer', () => {
    expect(evaluateOffer(undefined, REQ, [], [])).toEqual({
      ok: false,
      reasons: ['unknown_offer'],
    });
  });

  it('collects multiple reasons (Wed 15:00)', () => {
    // Wednesday 2026-11-18, 15:00–16:00 → outside_time_window + excluded_day
    const offer = mkOffer('o8', '2026-11-18T15:00', '2026-11-18T16:00');
    const result = evaluateOffer(offer, REQ, [], []);
    expect(result).toEqual({ ok: false, reasons: ['outside_time_window', 'excluded_day'] });
  });
});
