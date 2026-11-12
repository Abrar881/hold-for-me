/**
 * Simulated phone line for Hold For Me.
 *
 * Runs a deterministic IVR state machine, waits through simulated hold,
 * then delegates caller utterances to a scripted Receptionist.
 */
import type { Clinic, Profile } from '../data.js';
import type { LlmCall } from '../llm.js';
import type { PhoneLine, LineEvent } from './PhoneLine.js';
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

  async dial(signal: AbortSignal): Promise<LineEvent[]> {
    const root = this.ivrMachine.current();
    const events: LineEvent[] = [];

    if (root.terminal !== undefined) {
      // R3: root is itself a terminal — speak its prompt (if non-empty), then resolve
      if (root.prompt) {
        events.push({ kind: 'ivr', text: root.prompt });
      }
      events.push(...(await this.resolveTerminal(root.terminal, signal)));
    } else {
      events.push({ kind: 'ivr', text: root.prompt });
    }

    return events;
  }

  async sendDigits(d: string, signal: AbortSignal): Promise<LineEvent[]> {
    const result = this.ivrMachine.press(d);
    const events: LineEvent[] = [];

    switch (result.kind) {
      case 'prompt':
        // Valid navigation to a non-terminal node, or wrong-key sorry text (N1)
        events.push({ kind: 'ivr', text: result.text });
        break;

      case 'invalid':
        // Press on a terminal node — treat as ivr event
        events.push({ kind: 'ivr', text: result.text });
        break;

      case 'disconnected':
        events.push({ kind: 'ivr', text: result.text });
        events.push({ kind: 'hangup', reason: 'ivr_disconnect' });
        break;

      case 'terminal': {
        // R3: speak the terminal node's prompt (if non-empty), then resolve
        const node = this.ivrMachine.current();
        if (node.prompt) {
          events.push({ kind: 'ivr', text: node.prompt });
        }
        events.push(...(await this.resolveTerminal(result.terminal, signal)));
        break;
      }
    }

    return events;
  }

  async say(text: string, signal: AbortSignal): Promise<LineEvent[]> {
    if (this.receptionist === undefined) {
      return [{ kind: 'ivr', text: 'Please use your keypad.' }];
    }

    const result = await this.receptionist.respond(text, signal);
    const events: LineEvent[] = [
      {
        kind: 'speech',
        speaker: 'receptionist',
        text: result.text,
        offer: result.offer,
        booking: result.booking,
      },
    ];

    if (result.hungUp) {
      events.push({ kind: 'hangup', reason: 'receptionist' });
    }

    return events;
  }

  // ─── Terminal resolution ────────────────────────────────────────────────────

  private async resolveTerminal(
    terminal: 'hold' | 'receptionist' | 'closed',
    signal: AbortSignal,
  ): Promise<LineEvent[]> {
    const events: LineEvent[] = [];

    switch (terminal) {
      case 'hold': {
        const holdMs = this.clinic.holdSeconds * this.holdScale * 1000;
        events.push({ kind: 'hold', seconds: this.clinic.holdSeconds });
        // May throw AbortError if signal fires during sleep
        await this.sleep(holdMs, signal);
        this.receptionist = new Receptionist(
          this.clinic,
          this.book,
          this.profile,
          this.llm,
          this.today,
        );
        events.push({
          kind: 'speech',
          speaker: 'receptionist',
          text: this.receptionist.greet(),
        });
        break;
      }

      case 'receptionist': {
        this.receptionist = new Receptionist(
          this.clinic,
          this.book,
          this.profile,
          this.llm,
          this.today,
        );
        events.push({
          kind: 'speech',
          speaker: 'receptionist',
          text: this.receptionist.greet(),
        });
        break;
      }

      case 'closed': {
        events.push({ kind: 'hangup', reason: 'closed' });
        break;
      }
    }

    return events;
  }
}
