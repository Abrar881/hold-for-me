/**
 * PhoneLine interface and LineEvent discriminated union for Hold For Me.
 *
 * Abstracts the simulated (and future real) phone connection so that the
 * orchestrator can drive calls without knowing whether it talks to a real
 * carrier or a scripted fixture.
 */
import type { Offer, Booking } from '../../shared/types.js';
import type { SlotBook } from './slotBook.js';

export type LineEvent =
  | { kind: 'ivr'; text: string }
  | { kind: 'hold'; seconds: number }
  | { kind: 'speech'; speaker: 'receptionist'; text: string; offer?: Offer; booking?: Booking }
  | { kind: 'hangup'; reason: 'receptionist' | 'ivr_disconnect' | 'closed' };

export interface PhoneLine {
  /** Place the call; returns initial events (IVR prompt or immediate terminal). */
  dial(signal: AbortSignal): Promise<LineEvent[]>;
  /** Send DTMF digits; returns IVR navigation or terminal resolution events. */
  sendDigits(d: string, signal: AbortSignal): Promise<LineEvent[]>;
  /** Speak to the receptionist (or get a keypad-hint if not yet connected). */
  say(text: string, signal: AbortSignal): Promise<LineEvent[]>;
  /** The underlying slot book — orchestrator seam used for gating and booking. */
  slotBook(): SlotBook;
}
