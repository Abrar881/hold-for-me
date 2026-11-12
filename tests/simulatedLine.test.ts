import { describe, it, expect, vi } from 'vitest';
import { SimulatedLine, defaultSleep } from '../src/server/line/SimulatedLine.js';
import type { Clinic, Profile } from '../src/server/data.js';
import { fakeLlm } from './helpers/fakeLlm.js';

/** Bright Smile Dental fixture — mirrors the real JSON but with concrete slot dates. */
const CLINIC: Clinic = {
  id: 'bright-smile',
  name: 'Bright Smile Dental',
  service: 'dental',
  receptionistName: 'Sarah',
  persona: 'Warm and efficient receptionist.',
  holdSeconds: 8,
  ivr: [
    {
      id: 'root',
      prompt:
        'Thanks for calling Bright Smile Dental. For appointments press 1, for billing press 2.',
      options: { '1': 'hold-node', '2': 'billing' },
    },
    {
      id: 'hold-node',
      prompt: '',
      options: {},
      terminal: 'hold',
    },
    {
      id: 'billing',
      prompt: '',
      options: {},
      terminal: 'closed',
    },
  ],
  slots: [{ slotId: 'bs-1', start: '2026-11-24T09:00', end: '2026-11-24T09:30' }],
  quirks: { asksDob: true },
  demoRequest: 'Book me a check-up at Bright Smile next week, mornings.',
};

const PROFILE: Profile = {
  name: 'Alice Brown',
  dob: '1990-05-15',
  phone: '07700900000',
  existingPatientAt: [],
  fields: {},
};

const TODAY = '2026-11-12';

describe('SimulatedLine', () => {
  it('dial returns root IVR prompt', async () => {
    const signal = new AbortController().signal;
    const line = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 0,
      sleep: async () => {},
      today: TODAY,
    });
    const events = await line.dial(signal);
    expect(events).toEqual([{ kind: 'ivr', text: CLINIC.ivr[0].prompt }]);
  });

  it('pressing 1 at bright-smile yields hold 8s then greeting', async () => {
    const signal = new AbortController().signal;

    // holdScale 1: sleep called with 8000 ms
    const sleptMs: number[] = [];
    const fakeSleep = async (ms: number, _sig: AbortSignal) => {
      sleptMs.push(ms);
    };

    const line = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 1,
      sleep: fakeSleep,
      today: TODAY,
    });
    await line.dial(signal);
    const events = await line.sendDigits('1', signal);

    expect(events[0]).toEqual({ kind: 'hold', seconds: 8 });
    expect(events[1]).toMatchObject({ kind: 'speech', speaker: 'receptionist' });
    expect(sleptMs[0]).toBe(8000);

    // holdScale 0: sleep called with 0 ms
    const sleptMs2: number[] = [];
    const fakeSleep2 = async (ms: number, _sig: AbortSignal) => {
      sleptMs2.push(ms);
    };
    const line2 = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 0,
      sleep: fakeSleep2,
      today: TODAY,
    });
    await line2.dial(signal);
    await line2.sendDigits('1', signal);
    expect(sleptMs2[0]).toBe(0);
  });

  it('say before connection returns keypad hint', async () => {
    const signal = new AbortController().signal;
    const line = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 0,
      sleep: async () => {},
      today: TODAY,
    });
    await line.dial(signal);
    const events = await line.say('I need an appointment', signal);
    expect(events).toEqual([{ kind: 'ivr', text: 'Please use your keypad.' }]);
  });

  it('say after connection delegates to receptionist and passes offer through', async () => {
    const signal = new AbortController().signal;
    const llm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }], stop: 'tool_use' },
      { text: 'I can offer you an appointment on Monday at 9am.' },
    ]);

    const line = new SimulatedLine(CLINIC, PROFILE, llm, {
      holdScale: 0,
      sleep: async () => {},
      today: TODAY,
    });

    await line.dial(signal);
    await line.sendDigits('1', signal); // connect via hold terminal
    const events = await line.say('I need an appointment', signal);

    expect(events[0]).toMatchObject({
      kind: 'speech',
      speaker: 'receptionist',
      offer: expect.objectContaining({ slotId: 'bs-1' }),
    });
  });

  it('aborted signal rejects hold sleep with AbortError', async () => {
    const ac = new AbortController();

    // Sleep that only rejects — never resolves — so abort is the only exit
    const fakeSleep = (_ms: number, sig: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) =>
        sig.addEventListener('abort', () => reject(sig.reason), { once: true }),
      );

    const line = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 1,
      sleep: fakeSleep,
      today: TODAY,
    });

    await line.dial(ac.signal);
    const promise = line.sendDigits('1', ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow();
  });

  it('billing option ends with hangup closed', async () => {
    const signal = new AbortController().signal;
    const line = new SimulatedLine(CLINIC, PROFILE, fakeLlm([]), {
      holdScale: 0,
      sleep: async () => {},
      today: TODAY,
    });
    await line.dial(signal);
    const events = await line.sendDigits('2', signal);
    expect(events).toEqual([{ kind: 'hangup', reason: 'closed' }]);
  });

  it('defaultSleep removes abort listener after normal completion — no leak', async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');

    // Sleep completes normally (1 ms).
    await defaultSleep(1, ac.signal);

    // The timeout callback must remove the abort listener.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // Aborting after completion should not cause any additional effect.
    ac.abort();
    // Still one call — the { once: true } abort path never fired.
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('defaultSleep rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(defaultSleep(10_000, ac.signal)).rejects.toThrow();
  });
});
