/**
 * Offer gate: decides whether the AI caller may accept a clinic's offered slot.
 *
 * Rules are applied in order and all failing reasons are collected.  A `slot`
 * approval for the offer waives date/time/weekday checks (rules 2–4) but never
 * a calendar clash, because the user approved the time without seeing the clash.
 * A `fee` approval waives only the fee check (rule 6).
 */

import type {
  Offer,
  BookingRequest,
  CalendarEvent,
  Approval,
  GateResult,
  GateReason,
} from '../shared/types.js';
import { clashes } from './calendar.js';
import { weekdayOf } from './dates.js';

export function evaluateOffer(
  offer: Offer | undefined,
  req: BookingRequest,
  calendar: CalendarEvent[],
  approvals: Approval[],
): GateResult {
  // Rule 1: unknown offer
  if (offer === undefined) {
    return { ok: false, reasons: ['unknown_offer'] };
  }

  const reasons: GateReason[] = [];

  // Check whether this offer has a slot or fee approval from the user
  const hasSlotApproval = approvals.some(
    a => a.offerId === offer.offerId && a.kinds.includes('slot'),
  );
  const hasFeeApproval = approvals.some(
    a => a.offerId === offer.offerId && a.kinds.includes('fee'),
  );

  // Extract date and time parts from the ISO-local strings "YYYY-MM-DDTHH:MM"
  const date      = offer.start.slice(0, 10); // YYYY-MM-DD
  const startTime = offer.start.slice(11);    // HH:MM
  const endTime   = offer.end.slice(11);      // HH:MM

  // Rule 2: date outside dateFrom..dateTo (waived by slot approval)
  if (!hasSlotApproval && (date < req.dateFrom || date > req.dateTo)) {
    reasons.push('outside_dates');
  }

  // Rule 3: start before window start OR end after window end (waived by slot approval)
  if (!hasSlotApproval && (startTime < req.timeWindow.start || endTime > req.timeWindow.end)) {
    reasons.push('outside_time_window');
  }

  // Rule 4: weekday in excludedWeekdays (waived by slot approval)
  // weekdayOf returns 1=Mon…7=Sun; req.excludedWeekdays uses 0=Sun…6=Sat
  if (!hasSlotApproval) {
    const isoWeekday = weekdayOf(date);                      // 1–7
    const weekday    = isoWeekday === 7 ? 0 : isoWeekday;   // 0–6
    if (req.excludedWeekdays.includes(weekday)) {
      reasons.push('excluded_day');
    }
  }

  // Rule 5: calendar clash — never waived by any approval
  if (clashes(offer, calendar).length > 0) {
    reasons.push('calendar_clash');
  }

  // Rule 6: fee not approved (waived by fee approval)
  if (!hasFeeApproval && (offer.conditions.feeGbp ?? 0) > 0) {
    reasons.push('fee_unapproved');
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
