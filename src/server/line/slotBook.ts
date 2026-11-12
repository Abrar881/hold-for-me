/**
 * Scripted slot book with booking preconditions.
 *
 * Maintains available slots in the clinic's scripted offer order.
 * Tracks per-offer state (accepted, fee acknowledged, info provided)
 * and enforces all preconditions before confirming a booking.
 */
import type { Clinic } from '../data.js';
import type { Slot, Offer, OfferConditions, Booking } from '../../shared/types.js';

type BookResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'not_confirmed' | 'fee_not_acknowledged' | 'info_missing' | 'taken' | 'unknown_offer' };

interface OfferState {
  offer: Offer;
  accepted: boolean;
  feeAcknowledged: boolean;
  infoProvided: Set<string>;
}

export class SlotBook {
  private readonly clinic: Clinic;
  private readonly isNewPatient: boolean;
  private readonly offers = new Map<string, OfferState>();
  private offerCounter = 0;
  private readonly bookedSlotIds = new Set<string>();
  private currentBooking: Booking | undefined;

  constructor(clinic: Clinic, isNewPatient: boolean) {
    this.clinic = clinic;
    this.isNewPatient = isNewPatient;
  }

  /**
   * Return available slots whose start date falls within [from, to],
   * preserving the scripted order from clinic.slots (not sorted by date).
   */
  list(from: string, to: string): Slot[] {
    return this.clinic.slots.filter(s => {
      if (this.bookedSlotIds.has(s.slotId)) return false;
      const date = s.start.slice(0, 10); // YYYY-MM-DD
      return date >= from && date <= to;
    });
  }

  /**
   * Create an offer for `slotId`.
   * Attaches fee and required-info conditions when this is a new patient
   * and the clinic has the relevant quirks.
   */
  makeOffer(slotId: string): Offer | { error: string } {
    const slot = this.clinic.slots.find(s => s.slotId === slotId);
    if (!slot) return { error: `Unknown slot: ${slotId}` };

    const offerId = `off-${++this.offerCounter}`;
    const conditions: OfferConditions = {};

    if (this.isNewPatient) {
      if (this.clinic.quirks.newPatientFeeGbp !== undefined) {
        conditions.feeGbp = this.clinic.quirks.newPatientFeeGbp;
      }
      if (this.clinic.quirks.requiresInfoForNewPatients?.length) {
        conditions.requiredInfo = this.clinic.quirks.requiresInfoForNewPatients;
      }
    }

    const offer: Offer = {
      offerId,
      slotId: slot.slotId,
      start: slot.start,
      end: slot.end,
      conditions,
    };

    this.offers.set(offerId, {
      offer,
      accepted: false,
      feeAcknowledged: false,
      infoProvided: new Set(),
    });

    return offer;
  }

  getOffer(offerId: string): Offer | undefined {
    return this.offers.get(offerId)?.offer;
  }

  /** Called only by the orchestrator after the gate passes. */
  markAccepted(offerId: string): void {
    const state = this.offers.get(offerId);
    if (state) state.accepted = true;
  }

  /** Called by the orchestrator when the gate passed with a fee approval. */
  acknowledgeFee(offerId: string): void {
    const state = this.offers.get(offerId);
    if (state) state.feeAcknowledged = true;
  }

  provideInfo(offerId: string, field: string): void {
    const state = this.offers.get(offerId);
    if (state) state.infoProvided.add(field);
  }

  book(offerId: string, _patientName: string): BookResult {
    const state = this.offers.get(offerId);
    if (!state) return { ok: false, reason: 'unknown_offer' };
    if (!state.accepted) return { ok: false, reason: 'not_confirmed' };

    const { offer } = state;

    if (offer.conditions.feeGbp !== undefined && !state.feeAcknowledged) {
      return { ok: false, reason: 'fee_not_acknowledged' };
    }

    if (offer.conditions.requiredInfo) {
      for (const field of offer.conditions.requiredInfo) {
        if (!state.infoProvided.has(field)) {
          return { ok: false, reason: 'info_missing' };
        }
      }
    }

    if (this.bookedSlotIds.has(offer.slotId)) {
      return { ok: false, reason: 'taken' };
    }

    this.bookedSlotIds.add(offer.slotId);

    const booking: Booking = {
      clinicId: this.clinic.id,
      clinicName: this.clinic.name,
      slotId: offer.slotId,
      start: offer.start,
      end: offer.end,
    };
    if (state.feeAcknowledged && offer.conditions.feeGbp !== undefined) {
      booking.feeGbp = offer.conditions.feeGbp;
    }

    this.currentBooking = booking;
    return { ok: true, booking };
  }

  booked(): Booking | undefined {
    return this.currentBooking;
  }
}
