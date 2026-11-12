/**
 * Offer descriptions used by the orchestrator: a structured line for the
 * caller agent and a plain spoken one for the user's check-in question.
 */
import type { Offer } from '../../shared/types.js';
import { weekdayOf } from '../dates.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** What the caller agent hears alongside the receptionist's words. */
export function describeOfferForAgent(o: Offer): string {
  const fee = o.conditions.feeGbp ? `, fee £${o.conditions.feeGbp}` : '';
  const info = o.conditions.requiredInfo?.length ? `, requires: ${o.conditions.requiredInfo.join(', ')}` : '';
  return `[Structured offer ${o.offerId}: ${o.start} to ${o.end}${fee}${info}]`;
}

/** Plain description of the real offer for the user, e.g. "(Thursday 19 November, 3:00pm, £20 fee)". */
export function describeOfferForUser(o: Offer): string {
  const date = o.start.slice(0, 10);
  const [, month, day] = date.split('-').map(Number);
  const [hh, mm] = o.start.slice(11, 16).split(':').map(Number);
  const time = `${hh % 12 || 12}:${String(mm).padStart(2, '0')}${hh < 12 ? 'am' : 'pm'}`;
  const parts = [`${WEEKDAYS[weekdayOf(date) - 1]} ${day} ${MONTHS[month - 1]}`, time];
  if (o.conditions.feeGbp) parts.push(`£${o.conditions.feeGbp} fee`);
  return `(${parts.join(', ')})`;
}
