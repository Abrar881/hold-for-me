import { describe, it, expect } from 'vitest';
import { SlotBook } from '../src/server/line/slotBook.js';
import { loadClinics } from '../src/server/data.js';
import type { Offer } from '../src/shared/types.js';

const TODAY = '2026-11-12'; // Thursday

function getClinics() {
  return loadClinics('data/clinics', TODAY);
}

describe('SlotBook', () => {
  it('lists in scripted order, not chronological: clearview list(next week..week+2) → Thu 15:00 first', () => {
    const clinics = getClinics();
    const clearview = clinics.find(c => c.id === 'clearview')!;
    const sb = new SlotBook(clearview, false);

    // cv-1 = 2026-11-19T15:00 (Thu week+1), cv-2 = 2026-11-23T09:30 (Mon week+2)
    const slots = sb.list('2026-11-16', '2026-11-29');
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots[0].slotId).toBe('cv-1');
    expect(slots[0].start).toBe('2026-11-19T15:00');
    // cv-2 Mon 09:30 (chronologically after Thu 15:00, so order matches — but we're
    // preserving scripted order, NOT sorting by time-of-day or date)
    expect(slots[1].slotId).toBe('cv-2');
  });

  it('offer for new patient at riverside carries feeGbp 20 and requiredInfo [insuranceNumber]', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, true /* new patient */);

    const result = sb.makeOffer('rv-1');
    expect('error' in result).toBe(false);
    const offer = result as Offer;
    expect(offer.offerId).toBe('off-1');
    expect(offer.conditions.feeGbp).toBe(20);
    expect(offer.conditions.requiredInfo).toEqual(['insuranceNumber']);
  });

  it('existing patient offer has no conditions', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, false /* existing patient */);

    const result = sb.makeOffer('rv-1');
    expect('error' in result).toBe(false);
    const offer = result as Offer;
    expect(offer.conditions).toEqual({});
  });

  it('book refuses before markAccepted → not_confirmed', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, false);

    const offer = sb.makeOffer('rv-1') as Offer;
    const result = sb.book(offer.offerId, 'Alex Khan');
    expect(result).toEqual({ ok: false, reason: 'not_confirmed' });
  });

  it('book refuses with fee unacknowledged, then succeeds after acknowledgeFee + provideInfo', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, true /* new patient — has fee + requiredInfo */);

    const offer = sb.makeOffer('rv-1') as Offer;
    sb.markAccepted(offer.offerId);

    // Fee not yet acknowledged
    expect(sb.book(offer.offerId, 'Alex Khan')).toEqual({
      ok: false,
      reason: 'fee_not_acknowledged',
    });

    sb.acknowledgeFee(offer.offerId);

    // Info not yet provided
    expect(sb.book(offer.offerId, 'Alex Khan')).toEqual({
      ok: false,
      reason: 'info_missing',
    });

    sb.provideInfo(offer.offerId, 'insuranceNumber');

    // Now all preconditions are met
    const result = sb.book(offer.offerId, 'Alex Khan');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.booking.clinicId).toBe('riverside');
      expect(result.booking.clinicName).toBe('Riverside Dental');
      expect(result.booking.slotId).toBe('rv-1');
      expect(result.booking.feeGbp).toBe(20);
    }
  });

  it('booked slot disappears from list; second book of same slot → taken', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, false /* existing patient */);

    // Book rv-1
    const offer1 = sb.makeOffer('rv-1') as Offer;
    sb.markAccepted(offer1.offerId);
    const r1 = sb.book(offer1.offerId, 'Alex Khan');
    expect(r1.ok).toBe(true);

    // rv-1 should not appear in subsequent list
    const remaining = sb.list('2026-11-16', '2026-11-29');
    expect(remaining.some(s => s.slotId === 'rv-1')).toBe(false);
    // rv-2 should still be listed
    expect(remaining.some(s => s.slotId === 'rv-2')).toBe(true);

    // Second offer for the same slot, all preconditions met → taken
    const offer2 = sb.makeOffer('rv-1') as Offer;
    sb.markAccepted(offer2.offerId);
    expect(sb.book(offer2.offerId, 'Alex Khan')).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('unknown offerId → unknown_offer', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, false);

    expect(sb.book('off-999', 'Alex Khan')).toEqual({
      ok: false,
      reason: 'unknown_offer',
    });
  });

  it('offer ids are unique per makeOffer call', () => {
    const clinics = getClinics();
    const riverside = clinics.find(c => c.id === 'riverside')!;
    const sb = new SlotBook(riverside, false);

    const o1 = sb.makeOffer('rv-1') as Offer;
    const o2 = sb.makeOffer('rv-2') as Offer;
    expect(o1.offerId).not.toBe(o2.offerId);
    expect(o1.offerId).toBe('off-1');
    expect(o2.offerId).toBe('off-2');
  });
});
