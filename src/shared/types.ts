export type Speaker = 'agent' | 'receptionist' | 'ivr' | 'assistant' | 'user';

export interface TimeWindow { start: string; end: string }            // HH:MM

export interface BookingRequest {
  clinicId: string; service: string; patientName: string;
  dateFrom: string; dateTo: string;                                    // YYYY-MM-DD inclusive
  timeWindow: TimeWindow; excludedWeekdays: number[];                  // 0=Sun..6=Sat
  notes?: string;
}

export interface Slot { slotId: string; start: string; end: string }   // YYYY-MM-DDTHH:MM

export interface OfferConditions { feeGbp?: number; requiredInfo?: string[] }

export interface Offer extends Slot { offerId: string; conditions: OfferConditions }

export type GateReason = 'outside_dates' | 'outside_time_window' | 'excluded_day'
  | 'calendar_clash' | 'fee_unapproved' | 'unknown_offer';

export type GateResult = { ok: true } | { ok: false; reasons: GateReason[] };

export type ApprovalKind = 'slot' | 'fee';

export interface Approval { offerId: string; kinds: ApprovalKind[] }

export interface CalendarEvent { title: string; start: string; end: string }

export interface TranscriptLine { at: number; speaker: Speaker; text: string; meta?: string }

export interface Booking { clinicId: string; clinicName: string; slotId: string; start: string; end: string; feeGbp?: number }

export interface CallOutcome {
  status: 'booked' | 'not_booked' | 'aborted';
  booking?: Booking; summary: string; transcript: TranscriptLine[];
}

export type SpeechMode = 'openai' | 'browser';
