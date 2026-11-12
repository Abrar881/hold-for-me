import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCall, type CallDeps } from '../src/server/orchestrator.js';
import { SimulatedLine } from '../src/server/line/SimulatedLine.js';
import { loadClinics, loadProfile, loadCalendar } from '../src/server/data.js';
import type { CallState } from '../src/server/agents/callerTools.js';
import type { LlmParams } from '../src/server/llm.js';
import type { SpeechProvider } from '../src/server/speech/SpeechProvider.js';
import type { BookingRequest } from '../src/shared/types.js';
import type { ServerMsg } from '../src/shared/protocol.js';
import { fakeLlm } from './helpers/fakeLlm.js';
import { fakeIo, fakeSpeech } from './helpers/fakeIo.js';

type Script = Parameters<typeof fakeLlm>[0];

const TODAY = '2026-11-12';
const clinics = loadClinics('data/clinics', TODAY);
const clinicById = (id: string) => clinics.find(c => c.id === id)!;
const profile = loadProfile('data', TODAY);
const calendar = loadCalendar('data', TODAY);

const REQUEST: BookingRequest = {
  clinicId: 'clearview',
  service: 'eye test',
  patientName: 'Alex Khan',
  dateFrom: '2026-11-16',
  dateTo: '2026-11-20',
  timeWindow: { start: '09:00', end: '12:00' },
  excludedWeekdays: [],
};

const GOODBYE = "I'm sorry, I'll have to call back later. Goodbye.";
const NO_ANSWER = "No answer from user. Decline politely and say you'll call back.";
const GREETING = 'Clearview Opticians, Priya speaking, how can I help?';

// ─── Script building blocks ────────────────────────────────────────────────────

const PRESS_1 = { tools: [{ name: 'press_keys', input: { digits: '1' } }] };
const INTRO_TEXT = "Hi, I'm an AI assistant calling on behalf of Alex Khan to book an eye test.";
const INTRO = { tools: [{ name: 'say', input: { text: INTRO_TEXT } }] };
const WAIT = { tools: [{ name: 'wait', input: {} }] };
const endCall = (outcome: 'booked' | 'not_booked', summary: string) => ({
  tools: [{ name: 'end_call', input: { outcome, summary } }],
});
const acceptOffer = (offerId: string) => ({ tools: [{ name: 'accept_offer', input: { offerId } }] });
const askUser = (question: string) => ({
  tools: [{ name: 'ask_user', input: { question, offerId: 'off-1', approvalFor: ['slot'] } }],
});
/** Receptionist offers cv-1 = Thu 2026-11-19 15:00 (outside the morning window). */
const OFFER_THU_3PM: Script = [
  { tools: [{ name: 'make_offer', input: { slotId: 'cv-1' } }] },
  { text: 'I can do Thursday the 19th at 3pm.' },
];
const unclear = { text: JSON.stringify({ decision: 'unclear', note: 'ambiguous' }) };

// ─── Harness ────────────────────────────────────────────────────────────────────

function setup(opts: {
  caller: Script;
  receptionist?: Script;
  interpret?: Script;
  answers?: (string | null)[];
  speech?: SpeechProvider;
  now?: () => number;
  clinicId?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const clinic = clinicById(opts.clinicId ?? 'clearview');
  const state: CallState = {
    request: { ...REQUEST, clinicId: clinic.id },
    profile,
    calendar,
    approvals: [],
    offers: new Map(),
    userAnswers: [],
  };
  const llm = fakeLlm(opts.caller);
  const recLlm = fakeLlm(opts.receptionist ?? []);
  const interpretLlm = fakeLlm(opts.interpret ?? []);
  const line = new SimulatedLine(clinic, profile, recLlm, {
    holdScale: 0,
    sleep: opts.sleep ?? (async () => {}),
    today: TODAY,
  });
  const io = fakeIo(opts.answers ?? []);
  const deps: CallDeps = {
    line,
    llm,
    interpretLlm,
    speech: opts.speech ?? fakeSpeech({ mode: 'browser' }),
    io,
    clinic,
    today: TODAY,
    now: opts.now,
  };
  const run = (signal: AbortSignal = new AbortController().signal) => runCall(state, deps, signal);
  return { state, llm, recLlm, interpretLlm, line, io, deps, run };
}

type Block = { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** Last message of a recorded caller request. */
function lastMessage(p: LlmParams) {
  return p.messages[p.messages.length - 1];
}

/** tool_result blocks of the last (user) message of a recorded request. */
function toolResults(p: LlmParams): Block[] {
  const content = lastMessage(p).content;
  if (!Array.isArray(content)) return [];
  return (content as Block[]).filter(b => b.type === 'tool_result');
}

function requestText(p: LlmParams): string {
  return JSON.stringify(p.messages);
}

function ofType<T extends ServerMsg['type']>(msgs: ServerMsg[], type: T) {
  return msgs.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('runCall', () => {
  it("prefixes AI disclosure when agent's first say lacks it", async () => {
    const h = setup({
      caller: [
        PRESS_1,
        { tools: [{ name: 'say', input: { text: "Hello, I'd like to book an eye test." } }] },
        { tools: [{ name: 'say', input: { text: 'Mornings please.' } }] },
        endCall('not_booked', 'No slot.'),
      ],
      receptionist: [{ text: 'Of course.' }, { text: 'Let me look.' }],
    });

    await h.run();

    const prefixed = "Hi, I'm an AI assistant calling on behalf of Alex Khan. Hello, I'd like to book an eye test.";
    expect(h.recLlm.calls[0].messages[0]).toEqual({ role: 'user', content: prefixed });
    const agentLines = h.io.spoken.filter(s => s.speaker === 'agent').map(s => s.text);
    expect(agentLines).toEqual([prefixed, 'Mornings please.']);
  });

  it('rejects out-of-window accept_offer without approval and does not book', async () => {
    const h = setup({
      caller: [PRESS_1, INTRO, acceptOffer('off-1'), endCall('not_booked', 'Only 3pm was available.')],
      receptionist: OFFER_THU_3PM,
    });

    const outcome = await h.run();

    expect(outcome.status).toBe('not_booked');
    expect(h.line.slotBook().booked()).toBeUndefined();
    // Caller heard the structured offer alongside the receptionist's words
    expect(requestText(h.llm.calls[2])).toContain('off-1');
    expect(h.state.offers.get('off-1')?.start).toBe('2026-11-19T15:00');
    // accept_offer result is an error mentioning the gate reason
    const [result] = toolResults(h.llm.calls[3]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('outside_time_window');
    // offer preview (from speech) + accept_offer result were both emitted
    const offers = ofType(h.io.emitted, 'offer');
    expect(offers).toHaveLength(2);
    expect(offers.every(o => o.offer.offerId === 'off-1' && !o.gate.ok)).toBe(true);
  });

  it('ask_user yes records slot approval and booking succeeds', async () => {
    const question = 'They can do Thursday 19 November at 3pm, outside your morning window. Is that OK?';
    const h = setup({
      caller: [
        PRESS_1,
        INTRO,
        {
          tools: [
            { name: 'say', input: { text: 'One moment please, let me check with Alex.' } },
            { name: 'ask_user', input: { question, offerId: 'off-1', approvalFor: ['slot'] } },
          ],
        },
        acceptOffer('off-1'),
        { tools: [{ name: 'say', input: { text: 'Yes please, book that.' } }] },
        endCall('booked', 'Booked Thursday 19 November at 3pm.'),
      ],
      receptionist: [
        ...OFFER_THU_3PM,
        { text: 'Of course, take your time.' },
        { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
        { text: "You're booked for Thursday at 3pm." },
      ],
      answers: ['yes please'],
    });

    const outcome = await h.run();

    expect(outcome.status).toBe('booked');
    expect(outcome.booking?.start).toBe('2026-11-19T15:00');
    expect(h.state.approvals).toEqual([{ offerId: 'off-1', kinds: ['slot'] }]);
    expect(h.state.userAnswers.map(a => a.text)).toEqual(['yes please']);

    // ask_user tool result
    const askResult = toolResults(h.llm.calls[3]).find(r => r.tool_use_id === 'tu_3_1')!;
    expect(JSON.parse(String(askResult.content))).toEqual({ decision: 'yes', userSaid: 'yes please' });

    // paused + needs_user emitted, question spoken on the user channel
    const statuses = ofType(h.io.emitted, 'call_status').map(s => s.phase);
    expect(statuses).toContain('paused');
    expect(statuses.slice(statuses.indexOf('paused'))).toEqual(['paused', 'talking', 'ended']);
    // The real offer is appended to what the user hears and approves
    const spokenQuestion = `${question} (Thursday 19 November, 3:00pm)`;
    expect(ofType(h.io.emitted, 'needs_user')).toEqual([
      { type: 'needs_user', question: spokenQuestion, timeoutMs: 15000, attempt: 1 },
    ]);
    expect(h.io.spoken.find(s => s.channel === 'user')?.text).toBe(spokenQuestion);
    expect(h.io.asked).toEqual([{ question: spokenQuestion, timeoutMs: 15000, attempt: 1 }]);

    // call_ended carries an .ics for the slot-book booking
    const [ended] = ofType(h.io.emitted, 'call_ended');
    expect(ended.outcome.status).toBe('booked');
    expect(ended.ics).toContain('DTSTART:20261119T150000');
  });

  it('ask_user unclear twice → no approval, tool result tells agent to decline', async () => {
    const h = setup({
      caller: [PRESS_1, INTRO, askUser('Thursday at 3pm, is that OK?'), acceptOffer('off-1'), endCall('not_booked', 'Declined.')],
      receptionist: OFFER_THU_3PM,
      interpret: [unclear, unclear],
      answers: ['uh, what time was it?', 'hmm, maybe'],
    });

    const outcome = await h.run();

    expect(h.io.asked.map(a => a.attempt)).toEqual([1, 2]);
    expect(ofType(h.io.emitted, 'needs_user').map(n => n.attempt)).toEqual([1, 2]);
    expect(h.interpretLlm.calls).toHaveLength(2);
    const [askResult] = toolResults(h.llm.calls[3]);
    expect(askResult.content).toBe(NO_ANSWER);
    expect(h.state.approvals).toEqual([]);
    const [acceptResult] = toolResults(h.llm.calls[4]);
    expect(acceptResult.is_error).toBe(true);
    expect(outcome.status).toBe('not_booked');
    expect(h.line.slotBook().booked()).toBeUndefined();
  });

  it('ask_user timeout (null) counts as no approval', async () => {
    const h = setup({
      caller: [PRESS_1, INTRO, askUser('Thursday at 3pm, is that OK?'), acceptOffer('off-1'), endCall('not_booked', 'No answer.')],
      receptionist: OFFER_THU_3PM,
      answers: [null, null],
    });

    const outcome = await h.run();

    expect(h.io.asked.map(a => a.attempt)).toEqual([1, 2]);
    expect(h.interpretLlm.calls).toHaveLength(0);
    expect(toolResults(h.llm.calls[3])[0].content).toBe(NO_ANSWER);
    expect(h.state.approvals).toEqual([]);
    expect(h.state.userAnswers).toEqual([]);
    expect(toolResults(h.llm.calls[4])[0].is_error).toBe(true);
    expect(outcome.status).toBe('not_booked');
  });

  it('agent claims booked but slot book empty → outcome not_booked with mismatch note', async () => {
    const h = setup({
      caller: [PRESS_1, INTRO, endCall('booked', 'Booked Thursday at 3pm.')],
      receptionist: [{ text: 'How can I help?' }],
    });

    const outcome = await h.run();

    expect(outcome.status).toBe('not_booked');
    expect(outcome.booking).toBeUndefined();
    expect(outcome.summary).toContain('(agent reported booked but clinic has no booking)');
    const [ended] = ofType(h.io.emitted, 'call_ended');
    expect(ended.ics).toBeUndefined();
  });

  it('text-only response is spoken as say', async () => {
    const text = "Hi, I'm an AI assistant calling for Alex Khan.";
    const h = setup({
      caller: [PRESS_1, { text }, endCall('not_booked', 'Done.')],
      receptionist: [{ text: 'Sure, how can I help?' }],
    });

    await h.run();

    expect(h.io.spoken.filter(s => s.speaker === 'agent').map(s => s.text)).toEqual([text]);
    expect(h.recLlm.calls[0].messages[0]).toEqual({ role: 'user', content: text });
    expect(requestText(h.llm.calls[2])).toContain('Sure, how can I help?');
  });

  it('stops at 40 iterations with goodbye line', async () => {
    const h = setup({ caller: Array.from({ length: 40 }, () => WAIT) });

    const outcome = await h.run();

    expect(h.llm.calls).toHaveLength(40);
    const agentLines = h.io.spoken.filter(s => s.speaker === 'agent');
    expect(agentLines[agentLines.length - 1].text).toBe(GOODBYE);
    expect(outcome.status).toBe('not_booked');
    expect(outcome.transcript.some(t => t.speaker === 'agent' && t.text === GOODBYE)).toBe(true);
  });

  it('stops at 300 s call duration with goodbye line', async () => {
    let t = 0;
    const tick = () => {
      t += 200_000;
      return WAIT;
    };
    const h = setup({ caller: [tick, tick, tick], now: () => t });

    const outcome = await h.run();

    expect(h.llm.calls).toHaveLength(2);
    expect(h.io.spoken[h.io.spoken.length - 1].text).toBe(GOODBYE);
    expect(outcome.status).toBe('not_booked');
  });

  it('openai mode: receptionist text goes through transcribe before reaching caller', async () => {
    const speech = fakeSpeech({
      mode: 'openai',
      synthesize: async text => ({ audio: Buffer.from(text), mime: 'audio/mpeg' }),
      transcribe: async audio => `[stt] ${audio.toString()}`,
    });
    const h = setup({ caller: [PRESS_1, endCall('not_booked', 'Done.')], speech });

    await h.run();

    expect(requestText(h.llm.calls[0])).toContain('[stt] Clearview Opticians. To book an eye test press 1');
    const [result] = toolResults(h.llm.calls[1]);
    expect(String(result.content)).toContain(`[stt] ${GREETING}`);
    // UI gets the original text plus audio
    const rec = h.io.spoken.find(s => s.speaker === 'receptionist')!;
    expect(rec.text).toBe(GREETING);
    expect(rec.audio?.audio.toString()).toBe(GREETING);
  });

  it('synthesize throwing degrades to text and call completes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transcribe = vi.fn(async () => 'should not be used');
    const speech = fakeSpeech({
      mode: 'openai',
      synthesize: async () => {
        throw new Error('TTS 503');
      },
      transcribe,
    });
    const h = setup({
      caller: [PRESS_1, INTRO, endCall('not_booked', 'Nothing suitable.')],
      receptionist: [{ text: 'Hello there!' }],
      speech,
    });

    const outcome = await h.run();

    expect(outcome.status).toBe('not_booked');
    expect(h.io.spoken.length).toBeGreaterThan(0);
    expect(h.io.spoken.every(s => s.audio === null)).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    expect(String(toolResults(h.llm.calls[1])[0].content)).toContain(GREETING);
    expect(String(toolResults(h.llm.calls[2])[0].content)).toContain('Hello there!');
    expect(warn).toHaveBeenCalled();
  });

  it('transcribe throwing falls back to the raw text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const speech = fakeSpeech({
      mode: 'openai',
      synthesize: async text => ({ audio: Buffer.from(text), mime: 'audio/mpeg' }),
      transcribe: async () => {
        throw new Error('STT timeout');
      },
    });
    const h = setup({ caller: [PRESS_1, endCall('not_booked', 'Done.')], speech });

    const outcome = await h.run();

    expect(outcome.status).toBe('not_booked');
    expect(String(toolResults(h.llm.calls[1])[0].content)).toContain(GREETING);
    expect(warn).toHaveBeenCalled();
  });

  it('refusal from caller llm → aborted outcome with summary', async () => {
    const h = setup({ caller: [{ stop: 'refusal' }] });

    const outcome = await h.run();

    expect(outcome.status).toBe('aborted');
    expect(outcome.summary.length).toBeGreaterThan(0);
    expect(h.llm.calls).toHaveLength(1);
    expect(ofType(h.io.emitted, 'call_ended')).toHaveLength(1);
  });

  it('all tool_results returned in a single user message', async () => {
    const h = setup({
      caller: [
        PRESS_1,
        {
          tools: [
            { name: 'check_calendar', input: { from: '2026-11-16', to: '2026-11-20' } },
            { name: 'get_profile_field', input: { field: 'dob' } },
            { name: 'get_profile_field', input: { field: 'insuranceNumber' } },
          ],
        },
        endCall('not_booked', 'Done.'),
      ],
    });

    await h.run();

    const req = h.llm.calls[2];
    // initial user + (assistant, user) × 2
    expect(req.messages).toHaveLength(5);
    expect(lastMessage(req).role).toBe('user');
    const results = toolResults(req);
    expect(results.map(r => r.tool_use_id)).toEqual(['tu_2_0', 'tu_2_1', 'tu_2_2']);
    expect(results[1].content).toBe('1998-04-03');
    expect(results[2].is_error).toBe(true);
    // system prompt is cached
    const system = req.system as { cache_control?: unknown }[];
    expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('aborting the signal rejects with AbortError and makes no further llm calls', async () => {
    const ac = new AbortController();
    const h = setup({
      caller: [
        PRESS_1,
        () => {
          ac.abort();
          return WAIT;
        },
        endCall('not_booked', 'unreachable'),
      ],
    });

    await expect(h.run(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.llm.calls).toHaveLength(2);
    expect(ofType(h.io.emitted, 'call_ended')).toHaveLength(0);
  });

  it('aborting while waiting for the user rejects with AbortError', async () => {
    const ac = new AbortController();
    const h = setup({
      caller: [PRESS_1, INTRO, askUser('Thursday at 3pm, is that OK?'), endCall('not_booked', 'unreachable')],
      receptionist: OFFER_THU_3PM,
    });
    h.io.askUser = () => {
      ac.abort();
      return new Promise<string | null>(() => {});
    };

    await expect(h.run(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.llm.calls).toHaveLength(3);
  });

  it('limit goodbye is sent down the line to a connected receptionist; reply ignored', async () => {
    const h = setup({
      caller: [PRESS_1, INTRO, ...Array.from({ length: 38 }, () => WAIT)],
      receptionist: [{ text: 'Hello, how can I help?' }, { text: 'No problem, goodbye.' }],
    });

    const outcome = await h.run();

    expect(h.llm.calls).toHaveLength(40);
    expect(h.recLlm.calls).toHaveLength(2);
    expect(lastMessage(h.recLlm.calls[1])).toEqual({ role: 'user', content: GOODBYE });
    expect(h.io.spoken.some(s => s.text === 'No problem, goodbye.')).toBe(false);
    expect(outcome.status).toBe('not_booked');
  });

  // ─── R11: ask_user field → provide_info(source: user) ─────────────────────────

  /** Riverside (new patient): rv-1 = Wed 2026-11-18 10:00, £20 fee, needs insuranceNumber. */
  const RIVERSIDE_OFFER: Script = [
    { tools: [{ name: 'make_offer', input: { slotId: 'rv-1' } }] },
    { text: 'Wednesday the 18th at 10am. New patients pay £20 and we need an insurance number.' },
  ];

  it('ask_user with field records the answer and provide_info(source user) succeeds → booked', async () => {
    const question =
      'Riverside can do Wed 18 Nov at 10am with a £20 new-patient fee, and they need your insurance number. OK, and what is it?';
    const h = setup({
      clinicId: 'riverside',
      caller: [
        INTRO,
        {
          tools: [
            { name: 'say', input: { text: 'One moment please, let me check with Alex.' } },
            {
              name: 'ask_user',
              input: { question, offerId: 'off-1', approvalFor: ['fee'], field: 'insuranceNumber' },
            },
          ],
        },
        {
          tools: [
            { name: 'accept_offer', input: { offerId: 'off-1' } },
            { name: 'provide_info', input: { offerId: 'off-1', field: 'insuranceNumber', source: 'user' } },
          ],
        },
        { tools: [{ name: 'say', input: { text: 'Yes please book it. My insurance number is RX-1234.' } }] },
        endCall('booked', 'Booked Wednesday 18 November at 10am.'),
      ],
      receptionist: [
        ...RIVERSIDE_OFFER,
        { text: 'Sure.' },
        { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
        { text: "All booked, see you Wednesday." },
      ],
      answers: ['yes, and my insurance number is RX-1234'],
    });

    const outcome = await h.run();

    expect(h.state.userAnswers).toEqual([
      { field: 'insuranceNumber', text: 'yes, and my insurance number is RX-1234' },
    ]);
    expect(h.state.approvals).toEqual([{ offerId: 'off-1', kinds: ['fee'] }]);
    expect(h.io.asked[0].question).toBe(`${question} (Wednesday 18 November, 10:00am, £20 fee)`);
    const results = toolResults(h.llm.calls[3]);
    expect(results.map(r => r.is_error ?? false)).toEqual([false, false]);
    expect(outcome.status).toBe('booked');
    expect(outcome.booking).toMatchObject({ start: '2026-11-18T10:00', feeGbp: 20 });
  });

  it('provide_info(source user) for a field never asked → isError, not booked', async () => {
    const h = setup({
      clinicId: 'riverside',
      caller: [
        INTRO,
        { tools: [{ name: 'provide_info', input: { offerId: 'off-1', field: 'insuranceNumber', source: 'user' } }] },
        endCall('not_booked', 'Missing insurance number.'),
      ],
      receptionist: RIVERSIDE_OFFER,
    });

    const outcome = await h.run();

    const [result] = toolResults(h.llm.calls[2]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('insuranceNumber');
    expect(outcome.status).toBe('not_booked');
  });

  // ─── R13: info requests count without a yes ────────────────────────────────────

  const infoFlow = (answers: (string | null)[]) =>
    setup({
      clinicId: 'riverside',
      caller: [
        INTRO,
        { tools: [{ name: 'ask_user', input: { question: "What's your insurance number?", field: 'insuranceNumber' } }] },
        { tools: [{ name: 'provide_info', input: { offerId: 'off-1', field: 'insuranceNumber', source: 'user' } }] },
        endCall('not_booked', 'Done.'),
      ],
      receptionist: RIVERSIDE_OFFER,
      answers,
    });

  it('info request answered with a bare value is recorded and provide_info(source user) succeeds', async () => {
    const h = infoFlow(['AB123456']);

    await h.run();

    expect(JSON.parse(String(toolResults(h.llm.calls[2])[0].content))).toEqual({
      decision: 'provided',
      field: 'insuranceNumber',
      userSaid: 'AB123456',
    });
    expect(h.interpretLlm.calls).toHaveLength(0);
    expect(h.state.userAnswers).toEqual([{ field: 'insuranceNumber', text: 'AB123456' }]);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBeFalsy();
    expect(h.io.asked).toHaveLength(1);
  });

  it('info request answered "no" is not recorded as the field', async () => {
    const h = infoFlow(['no']);

    await h.run();

    expect(JSON.parse(String(toolResults(h.llm.calls[2])[0].content))).toMatchObject({ decision: 'no' });
    expect(h.state.userAnswers.some(a => a.field !== undefined)).toBe(false);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBe(true);
  });

  it('info request answered with a question back re-asks, then records the real answer', async () => {
    const h = infoFlow(['which number do you mean?', 'AB123456']);

    await h.run();

    expect(h.io.asked.map(a => a.attempt)).toEqual([1, 2]);
    expect(h.state.userAnswers).toEqual([{ field: 'insuranceNumber', text: 'AB123456' }]);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBeFalsy();
  });

  it('info request answered "I don\'t know" / "no idea" is unclear: not recorded, then no answer', async () => {
    const h = infoFlow(["I don't know", 'no idea, sorry']);

    await h.run();

    expect(h.io.asked.map(a => a.attempt)).toEqual([1, 2]);
    expect(toolResults(h.llm.calls[2])[0].content).toBe(NO_ANSWER);
    expect(h.state.userAnswers).toEqual([]);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBe(true);
  });

  // ─── Review fix: approvals only for received offers ────────────────────────────

  it('ask_user approval for an offer not yet received is an error; the later offer is still gated', async () => {
    const h = setup({
      caller: [
        PRESS_1,
        // No offer exists yet: off-1 is only a guess at the next id
        { tools: [{ name: 'ask_user', input: { question: 'Is any afternoon OK?', offerId: 'off-1', approvalFor: ['slot'] } }] },
        INTRO,
        acceptOffer('off-1'),
        endCall('not_booked', 'Only 3pm was available.'),
      ],
      receptionist: OFFER_THU_3PM,
      answers: ['yes'],
    });

    const outcome = await h.run();

    const [askResult] = toolResults(h.llm.calls[2]);
    expect(askResult.is_error).toBe(true);
    expect(askResult.content).toBe('unknown offerId; only ask about an offer you have received');
    expect(h.io.asked).toHaveLength(0);
    expect(h.state.approvals).toEqual([]);
    // off-1 now exists (Thu 3pm, outside the window) and is still rejected
    expect(h.state.offers.has('off-1')).toBe(true);
    const [acceptResult] = toolResults(h.llm.calls[4]);
    expect(acceptResult.is_error).toBe(true);
    expect(String(acceptResult.content)).toContain('outside_time_window');
    expect(outcome.status).toBe('not_booked');
    expect(h.line.slotBook().booked()).toBeUndefined();
  });

  it('info request with timeout then empty answer re-asks once, then reports no answer', async () => {
    const h = infoFlow([null, '   ']);

    await h.run();

    expect(h.io.asked.map(a => a.attempt)).toEqual([1, 2]);
    expect(toolResults(h.llm.calls[2])[0].content).toBe(NO_ANSWER);
    expect(h.state.userAnswers).toEqual([]);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBe(true);
  });

  it('approval + field answered with a bare "yes please" approves but does not record the field', async () => {
    const h = setup({
      clinicId: 'riverside',
      caller: [
        INTRO,
        {
          tools: [
            {
              name: 'ask_user',
              input: {
                question: 'There is a £20 fee and they need your insurance number. OK?',
                offerId: 'off-1',
                approvalFor: ['fee'],
                field: 'insuranceNumber',
              },
            },
          ],
        },
        { tools: [{ name: 'provide_info', input: { offerId: 'off-1', field: 'insuranceNumber', source: 'user' } }] },
        endCall('not_booked', 'Done.'),
      ],
      receptionist: RIVERSIDE_OFFER,
      answers: ['yes please'],
    });

    await h.run();

    expect(h.state.approvals).toEqual([{ offerId: 'off-1', kinds: ['fee'] }]);
    expect(h.state.userAnswers).toEqual([{ text: 'yes please' }]);
    expect(toolResults(h.llm.calls[3])[0].is_error).toBe(true);
  });

  // ─── R12: live line events ─────────────────────────────────────────────────────

  it('emits hold start before the hold sleep completes, hold end after', async () => {
    let releaseSleep!: () => void;
    let sleepStarted!: () => void;
    const sleeping = new Promise<void>(r => (sleepStarted = r));
    const sleep = () =>
      new Promise<void>(resolve => {
        releaseSleep = resolve;
        sleepStarted();
      });
    const h = setup({ clinicId: 'bright-smile', caller: [PRESS_1, endCall('not_booked', 'Done.')], sleep });

    const done = h.run();
    await sleeping;
    await new Promise(r => setTimeout(r, 0));

    // Mid-hold: start emitted live, no end yet, greeting not spoken yet
    const holdsMid = ofType(h.io.emitted, 'hold');
    expect(holdsMid).toEqual([{ type: 'hold', state: 'start', seconds: 8 }]);
    expect(ofType(h.io.emitted, 'call_status').map(s => s.phase)).toContain('hold');
    expect(h.io.spoken.some(s => s.speaker === 'receptionist')).toBe(false);

    releaseSleep();
    const outcome = await done;

    expect(ofType(h.io.emitted, 'hold')).toEqual([
      { type: 'hold', state: 'start', seconds: 8 },
      { type: 'hold', state: 'end' },
    ]);
    expect(h.io.spoken.find(s => s.speaker === 'receptionist')?.text).toBe(
      'Bright Smile Dental, Sarah speaking, how can I help?',
    );
    // The agent still hears the full batch, in order
    const heard = String(toolResults(h.llm.calls[1])[0].content);
    expect(heard.indexOf('[On hold for 8 seconds]')).toBeLessThan(heard.indexOf('Sarah speaking'));
    expect(outcome.status).toBe('not_booked');
  });
});
