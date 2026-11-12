/**
 * Simulated phone line for Hold For Me.
 *
 * Runs a deterministic IVR state machine, waits through simulated hold,
 * then delegates caller utterances to a scripted Receptionist.
 */
import type { Clinic, Profile } from '../data.js';
import type { LlmCall } from '../llm.js';
import type { PhoneLine, LineEvent, OnLineEvent } from './PhoneLine.js';
import { Ivr } from './ivr.js';
import { SlotBook } from './slotBook.js';
import { Receptionist } from './receptionist.js';

export type SimulatedLineOpts = {
  /** Multiplier applied to clinic.holdSeconds: 1 for real time, 0 for instant. */
  holdScale: number;
  /**
   * Abortable sleep implementation.
   * Defaults to a real setTimeout that cancels on abort.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Today's date as YYYY-MM-DD, forwarded to the Receptionist. */
  today: string;
};

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  // Reject immediately if already aborted.
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SimulatedLine implements PhoneLine {
  private readonly clinic: Clinic;
  private readonly profile: Profile;
  private readonly llm: LlmCall;
  private readonly holdScale: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly today: string;

  private readonly ivrMachine: Ivr;
  private readonly book: SlotBook;
  private receptionist: Receptionist | undefined = undefined;

  constructor(clinic: Clinic, profile: Profile, llm: LlmCall, opts: SimulatedLineOpts) {
    this.clinic = clinic;
    this.profile = profile;
    this.llm = llm;
    this.holdScale = opts.holdScale;
    this.today = opts.today;
    this.sleep = opts.sleep ?? defaultSleep;

    this.ivrMachine = new Ivr(clinic.ivr);
    // R2: isNewPatient = !profile.existingPatientAt.includes(clinic.id)
    const isNewPatient = !profile.existingPatientAt.includes(clinic.id);
    this.book = new SlotBook(clinic, isNewPatient);
  }

  slotBook(): SlotBook {
    return this.book;
  }

  async dial(signal: AbortSignal, onEvent?: OnLineEvent): Promise<LineEvent[]> {
    const out = collect(onEvent);
    const root = this.ivrMachine.current();

    if (root.terminal !== undefined) {
      // R3: root is itself a terminal — speak its prompt (if non-empty), then resolve
      if (root.prompt) {
        out.push({ kind: 'ivr', text: root.prompt });
      }
      await this.resolveTerminal(root.terminal, signal, out.push);
    } else {
      out.push({ kind: 'ivr', text: root.prompt });
    }

    return out.events;
  }

  async sendDigits(d: string, signal: AbortSignal, onEvent?: OnLineEvent): Promise<LineEvent[]> {
    const out = collect(onEvent);
    const result = this.ivrMachine.press(d);

    switch (result.kind) {
      case 'prompt':
        // Valid navigation to a non-terminal node, or wrong-key sorry text (N1)
        out.push({ kind: 'ivr', text: result.text });
        break;

      case 'invalid':
        // Press on a terminal node — treat as ivr event
        out.push({ kind: 'ivr', text: result.text });
        break;

      case 'disconnected':
        out.push({ kind: 'ivr', text: result.text });
        out.push({ kind: 'hangup', reason: 'ivr_disconnect' });
        break;

      case 'terminal': {
        // R3: speak the terminal node's prompt (if non-empty), then resolve
        const node = this.ivrMachine.current();
        if (node.prompt) {
          out.push({ kind: 'ivr', text: node.prompt });
        }
        await this.resolveTerminal(result.terminal, signal, out.push);
        break;
      }
    }

    return out.events;
  }

  async say(text: string, signal: AbortSignal, onEvent?: OnLineEvent): Promise<LineEvent[]> {
    const out = collect(onEvent);
    if (this.receptionist === undefined) {
      out.push({ kind: 'ivr', text: 'Please use your keypad.' });
      return out.events;
    }

    const result = await this.receptionist.respond(text, signal);
    out.push({
      kind: 'speech',
      speaker: 'receptionist',
      text: result.text,
      offer: result.offer,
      booking: result.booking,
    });

    if (result.hungUp) {
      out.push({ kind: 'hangup', reason: 'receptionist' });
    }

    return out.events;
  }

  // ─── Terminal resolution ────────────────────────────────────────────────────

  /** Pushes terminal events as they happen: the hold event before the hold sleep. */
  private async resolveTerminal(
    terminal: 'hold' | 'receptionist' | 'closed',
    signal: AbortSignal,
    push: (e: LineEvent) => void,
  ): Promise<void> {
    switch (terminal) {
      case 'hold': {
        const holdMs = this.clinic.holdSeconds * this.holdScale * 1000;
        push({ kind: 'hold', seconds: this.clinic.holdSeconds });
        // May throw AbortError if signal fires during sleep
        await this.sleep(holdMs, signal);
        this.connectReceptionist(push);
        break;
      }

      case 'receptionist':
        this.connectReceptionist(push);
        break;

      case 'closed':
        push({ kind: 'hangup', reason: 'closed' });
        break;
    }
  }

  private connectReceptionist(push: (e: LineEvent) => void): void {
    this.receptionist = new Receptionist(this.clinic, this.book, this.profile, this.llm, this.today);
    push({ kind: 'speech', speaker: 'receptionist', text: this.receptionist.greet() });
  }
}

/** Collects events for the return value and forwards each one to onEvent immediately. */
function collect(onEvent?: OnLineEvent): { events: LineEvent[]; push: (e: LineEvent) => void } {
  const events: LineEvent[] = [];
  return {
    events,
    push: e => {
      events.push(e);
      onEvent?.(e);
    },
  };
}
