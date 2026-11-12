/**
 * Tests for src/server/session.ts
 *
 * Uses fake LLMs, BrowserSpeech (mode: 'browser'), holdScale:0 and an
 * instant-sleep stub so the full state machine runs in-process without
 * real I/O.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { Session, type SessionDeps } from '../src/server/session.js';
import { loadClinics, loadProfile } from '../src/server/data.js';
import type { ServerMsg, ClientMsg } from '../src/shared/protocol.js';
import type { LlmCall, LlmParams, LlmMessage } from '../src/server/llm.js';
import type { Config } from '../src/server/config.js';
import { fakeLlm } from './helpers/fakeLlm.js';
import { fakeSpeech } from './helpers/fakeIo.js';

// ─── Static fixtures ──────────────────────────────────────────────────────────

const TODAY = '2026-11-12';
const DATA_DIR = 'data';
const DATA_CLINICS_DIR = path.join(DATA_DIR, 'clinics');

const allClinics = loadClinics(DATA_CLINICS_DIR, TODAY);
const profile = loadProfile(DATA_DIR, TODAY);
const brightSmile = allClinics.find(c => c.id === 'bright-smile')!;

// ─── Config factory ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicKey: 'test-key',
    speechMode: 'browser',
    callerModel: 'claude-haiku-5-5',
    receptionistModel: 'claude-haiku-5-5',
    interpretModel: 'claude-haiku-5-5',
    callerEffort: 'low',
    receptionistEffort: 'low',
    today: TODAY,
    holdScale: 0,
    port: 3001,
    ...overrides,
  };
}

// ─── Intake "ready" JSON for bright-smile ────────────────────────────────────

/**
 * Intake LLM script: single call returning the structured JSON for bright-smile.
 * excludedWeekdays: [3] = no Wednesday (0=Sun..6=Sat).
 * dateFrom/dateTo: next week (2026-11-16..2026-11-22).
 */
const BRIGHT_SMILE_INTAKE_JSON = JSON.stringify({
  clinicId: 'bright-smile',
  service: 'dental check-up',
  dateFrom: '2026-11-16',
  dateTo: '2026-11-22',
  timeWindow: 'mornings',
  excludedWeekdays: [3],
  notes: null,
  clarifyingQuestion: null,
  summary: 'Book a dental check-up at Bright Smile Dental next week mornings not Wednesday',
});

const intakeReady = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

// ─── Receptionist script for a successful booking ────────────────────────────
// bright-smile slot bs-1: Tuesday next week at 09:00 (morning, within window)
//
// LLM call 1: make_offer{bs-1}
// LLM call 2: text reply after offer created
// LLM call 3: book_slot{off-1}
// LLM call 4: text reply after booking confirmed

const receptionistBooked = fakeLlm([
  { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
  { text: 'I can offer Tuesday the 17th at 9am.' },
  { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
  { text: "Great, you're booked for Tuesday the 17th at 9am!" },
]);

// ─── Caller script for bright-smile (IVR → hold → receptionist) ──────────────
// dial   → IVR root prompt "Thanks for calling..."
// LLM 1: press_keys "1"
// sendDigits("1") → hold-node (terminal:hold) → 0s hold → receptionist greets
// LLM 2: say intro  (AI disclosure required)
// line.say(intro) → receptionist offers bs-1
// LLM 3: accept_offer "off-1"  (gate: bs-1 is mornings, not Wednesday → passes)
// LLM 4: say "please book it"
// line.say → receptionist books
// LLM 5: end_call booked

const callerBooked = fakeLlm([
  { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
  {
    tools: [
      {
        name: 'say',
        input: { text: "Hi, I'm an AI assistant calling on behalf of Alex Khan to book a dental check-up." },
      },
    ],
  },
  { tools: [{ name: 'accept_offer', input: { offerId: 'off-1' } }] },
  { tools: [{ name: 'say', input: { text: 'Thank you, please go ahead and book that for us.' } }] },
  {
    tools: [{ name: 'end_call', input: { outcome: 'booked', summary: 'Booked Bright Smile for Tuesday 9am' } }],
  },
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal TestSession wrapping a real Session.
 *
 * Records every outgoing message and allows callers to wait for a specific
 * message type via `waitFor()`.
 */
class TestSession {
  private readonly inner: Session;
  readonly messages: ServerMsg[] = [];
  private readonly waiters: Array<{
    type: string;
    resolve: (m: ServerMsg) => void;
  }> = [];

  constructor(deps: SessionDeps) {
    this.inner = new Session(msg => {
      this.messages.push(msg);
      const idx = this.waiters.findIndex(w => w.type === msg.type);
      if (idx !== -1) {
        const [waiter] = this.waiters.splice(idx, 1);
        waiter.resolve(msg);
      }
    }, deps);
  }

  handle(msg: ClientMsg): Promise<void> {
    return this.inner.handle(msg);
  }

  dispose(): void {
    this.inner.dispose();
  }

  /**
   * Resolves with the first already-received or next arriving message of `type`.
   * Times out after 5 seconds (should never happen in unit tests).
   */
  waitFor<T extends ServerMsg['type']>(
    type: T,
  ): Promise<Extract<ServerMsg, { type: T }>> {
    const existing = this.messages.find(m => m.type === type);
    if (existing) return Promise.resolve(existing as Extract<ServerMsg, { type: T }>);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`waitFor('${type}') timed out`)),
        5000,
      );
      this.waiters.push({
        type,
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg as Extract<ServerMsg, { type: T }>);
        },
      });
    });
  }

  /** All messages of a given type (snapshot). */
  ofType<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type);
  }
}

/** LLM that blocks until the AbortSignal fires, then rejects. */
function neverLlm(): LlmCall & { callCount: number } {
  let callCount = 0;
  const llm = async (_p: Omit<LlmParams, 'model'>, signal?: AbortSignal): Promise<LlmMessage> => {
    callCount++;
    return new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        return;
      }
      if (signal) {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }
    });
  };
  Object.defineProperty(llm, 'callCount', { get: () => callCount });
  return llm as unknown as LlmCall & { callCount: number };
}

// ─── Temp directory per test ──────────────────────────────────────────────────

let tmpDir: string;

function setupTmpDir(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  fs.writeFileSync(path.join(tmpDir, 'calendar.json'), '[]', 'utf-8');
}

function teardownTmpDir(): void {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Build a minimal SessionDeps, suitable for single-clinic tests. */
function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  const intakeLlm = overrides.llms?.intake ?? fakeLlm([]);
  const interpretLlm = overrides.llms?.interpret ?? fakeLlm([]);
  return {
    config: makeConfig(),
    clinics: allClinics,
    profile,
    dataDir: tmpDir,
    llms: {
      caller: fakeLlm([]),
      receptionist: fakeLlm([]),
      intake: intakeLlm,
      interpret: interpretLlm,
      ...overrides.llms,
    },
    speech: fakeSpeech({ mode: 'browser' }),
    sleep: async () => {},
    ...overrides,
  };
}

afterEach(teardownTmpDir);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Session', () => {
  it('sends hello with speechMode and three scenarios', () => {
    setupTmpDir();
    const threeClinics = allClinics.slice(0, 3);
    const session = new TestSession(makeDeps({ clinics: threeClinics }));

    const hellos = session.ofType('hello');
    expect(hellos).toHaveLength(1);
    const hello = hellos[0];
    expect(hello.speechMode).toBe('browser');
    expect(hello.scenarios).toHaveLength(3);
    expect(hello.scenarios.map(s => s.id)).toContain('bright-smile');
    for (const scenario of hello.scenarios) {
      expect(scenario.id).toBeTruthy();
      expect(scenario.label).toBeTruthy();
      expect(scenario.requestText).toBeTruthy();
    }
    session.dispose();
  });

  it('choose_scenario → request_understood → confirm yes → call_ended booked', async () => {
    setupTmpDir();
    // Fresh LLM instances per test
    const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: {
              text: "Hi, I'm an AI assistant calling on behalf of Alex Khan to book a dental check-up.",
            },
          },
        ],
      },
      { tools: [{ name: 'accept_offer', input: { offerId: 'off-1' } }] },
      { tools: [{ name: 'say', input: { text: 'Please go ahead and book that for us.' } }] },
      {
        tools: [
          {
            name: 'end_call',
            input: { outcome: 'booked', summary: 'Booked Bright Smile for Tuesday 9am' },
          },
        ],
      },
    ]);
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      { text: 'I can offer Tuesday the 17th at 9am.' },
      { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
      { text: "You're booked for Tuesday the 17th at 9am!" },
    ]);

    const session = new TestSession(
      makeDeps({
        llms: {
          caller: callerLlm,
          receptionist: recLlm,
          intake: intakeLlm,
          interpret: fakeLlm([]),
        },
      }),
    );

    // choose_scenario triggers intake
    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });

    const reqUnderstood = await session.waitFor('request_understood');
    expect(reqUnderstood.request.clinicId).toBe('bright-smile');

    // Confirm starts the call
    await session.handle({ type: 'confirm', yes: true });

    // Wait for the call to complete
    const callEnded = await session.waitFor('call_ended');
    expect(callEnded.outcome.status).toBe('booked');
    expect(callEnded.outcome.booking).toBeDefined();
    expect(callEnded.outcome.booking?.clinicId).toBe('bright-smile');

    // appendBooking runs in runCall's .then() handler after several async levels
    // (end() → loop() → run() → .then). A macrotask boundary ensures all pending
    // microtasks have drained before we check the file.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    // appendBooking should have written the bookings file
    expect(fs.existsSync(path.join(tmpDir, 'calendar.bookings.json'))).toBe(true);

    session.dispose();
  });

  it('confirm no returns to idle and can receive another scenario', async () => {
    setupTmpDir();
    const intakeLlm = fakeLlm([
      { text: BRIGHT_SMILE_INTAKE_JSON },
      { text: BRIGHT_SMILE_INTAKE_JSON }, // second intake after re-open
    ]);

    const session = new TestSession(
      makeDeps({ llms: { ...makeDeps().llms, intake: intakeLlm } }),
    );

    // Run through intake
    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    await session.waitFor('request_understood');

    // Decline
    await session.handle({ type: 'confirm', yes: false });

    // Should have received an utterance with "Okay, cancelled."
    const utterances = session.ofType('utterance');
    expect(utterances.some(u => u.text.includes('cancelled'))).toBe(true);

    // Can start over — another choose_scenario should work (back in idle)
    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    const reqUnderstood2 = await session.waitFor('request_understood');
    expect(reqUnderstood2).toBeDefined();

    session.dispose();
  });

  it('user_utterance while calling routes to pending askUser', async () => {
    setupTmpDir();

    // Caller script: press_keys "1" → say intro (triggers receptionist make_offer → off-1) →
    // ask_user (off-1 is now in state.offers) → end_call
    // ask_user triggers io.askUser which emits needs_user and waits for the user's answer
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: { text: "Hi, I'm an AI assistant calling to book a dental check-up." },
          },
        ],
      },
      {
        tools: [
          {
            name: 'ask_user',
            input: {
              question: 'Is Tuesday 9am okay?',
              offerId: 'off-1',
              approvalFor: ['slot'],
            },
          },
        ],
      },
      // After user answers, end the call
      { tools: [{ name: 'end_call', input: { outcome: 'not_booked', summary: 'User confirmed time' } }] },
    ]);

    // Receptionist: offer bs-1 (triggered by caller's say) and then text reply
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      { text: 'I can offer Tuesday the 17th at 9am.' },
    ]);

    const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

    const session = new TestSession(
      makeDeps({
        llms: {
          caller: callerLlm,
          receptionist: recLlm,
          intake: intakeLlm,
          interpret: fakeLlm([]),
        },
      }),
    );

    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    await session.waitFor('request_understood');
    await session.handle({ type: 'confirm', yes: true });

    // Wait for needs_user (the caller is asking us something)
    const needsUser = await session.waitFor('needs_user');
    expect(needsUser.question).toContain('Tuesday 9am');

    // Route the user's answer to the pending askUser
    await session.handle({ type: 'user_utterance', text: 'Yes, that works for me.' });

    // The call should now proceed to end
    const callEnded = await session.waitFor('call_ended');
    expect(callEnded.outcome.status).toBe('not_booked');

    session.dispose();
  });

  it('second choose_scenario during call → error, call continues', async () => {
    setupTmpDir();

    // Caller that asks the user (so the call pauses and we can interject).
    // say step first so receptionist calls make_offer → off-1 enters state.offers
    // before ask_user references it.
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: { text: "Hi, I'm an AI assistant calling to book a dental check-up." },
          },
        ],
      },
      {
        tools: [
          {
            name: 'ask_user',
            input: {
              question: 'Is Tuesday 9am okay?',
              offerId: 'off-1',
              approvalFor: ['slot'],
            },
          },
        ],
      },
      { tools: [{ name: 'end_call', input: { outcome: 'not_booked', summary: 'Done' } }] },
    ]);
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      { text: 'Tuesday 9am.' },
    ]);
    const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

    const session = new TestSession(
      makeDeps({
        llms: {
          caller: callerLlm,
          receptionist: recLlm,
          intake: intakeLlm,
          interpret: fakeLlm([]),
        },
      }),
    );

    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    await session.waitFor('request_understood');
    await session.handle({ type: 'confirm', yes: true });

    // Wait for the call to pause on needs_user
    await session.waitFor('needs_user');

    // Try to start a new scenario during the call — should get an error
    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });

    const errors = session.ofType('error');
    expect(errors.some(e => e.message.toLowerCase().includes('call'))).toBe(true);

    // Resume the call — it should still be in progress
    await session.handle({ type: 'user_utterance', text: 'Yes' });
    const callEnded = await session.waitFor('call_ended');
    expect(callEnded).toBeDefined();

    session.dispose();
  });

  it('user_utterance in calling state without active needs_user is ignored, not buffered', async () => {
    // An utterance sent while calling but before any needs_user is emitted must be dropped
    // so it cannot pre-approve a future ask_user question.
    setupTmpDir();

    // Caller: say intro → ask_user (off-1) → end_call.
    // We send a user_utterance BEFORE needs_user is emitted (during the say step),
    // then send the real answer only after needs_user arrives.
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: { text: "Hi, I'm an AI assistant calling to book a dental check-up." },
          },
        ],
      },
      {
        tools: [
          {
            name: 'ask_user',
            input: {
              question: 'Is Tuesday 9am okay?',
              offerId: 'off-1',
              approvalFor: ['slot'],
            },
          },
        ],
      },
      { tools: [{ name: 'end_call', input: { outcome: 'not_booked', summary: 'Done' } }] },
    ]);
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      { text: 'Tuesday 9am.' },
    ]);
    const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

    const session = new TestSession(
      makeDeps({
        llms: {
          caller: callerLlm,
          receptionist: recLlm,
          intake: intakeLlm,
          interpret: fakeLlm([]),
        },
      }),
    );

    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    await session.waitFor('request_understood');
    await session.handle({ type: 'confirm', yes: true });

    // Send an utterance immediately after the call starts, while calling state is set
    // but before any needs_user has been emitted. This must be ignored/dropped.
    await session.handle({ type: 'user_utterance', text: 'early spurious answer' });

    // Now wait for the real needs_user and answer it
    await session.waitFor('needs_user');
    await session.handle({ type: 'user_utterance', text: 'Yes, that works for me.' });

    // The call should complete normally
    const callEnded = await session.waitFor('call_ended');
    expect(callEnded).toBeDefined();

    session.dispose();
  });

  it('dispose mid-call aborts: no further llm calls, no unhandled rejection', async () => {
    setupTmpDir();

    const unhandled: Error[] = [];
    const unhandledHandler = (err: Error) => unhandled.push(err);
    process.on('unhandledRejection', unhandledHandler);

    try {
      const callerLlm = neverLlm();
      const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

      // Receptionist doesn't matter — caller LLM blocks before line.say is called
      const recLlm = fakeLlm([
        { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
        { text: 'Tuesday 9am.' },
      ]);

      const session = new TestSession(
        makeDeps({
          llms: {
            caller: callerLlm,
            receptionist: recLlm,
            intake: intakeLlm,
            interpret: fakeLlm([]),
          },
        }),
      );

      // Run intake and confirm
      await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
      await session.waitFor('request_understood');
      await session.handle({ type: 'confirm', yes: true });

      // Let the call start running (caller LLM blocks on first call)
      await new Promise(resolve => setTimeout(resolve, 50));

      const llmCallsBefore = callerLlm.callCount;

      // Dispose aborts the call
      session.dispose();

      // Allow the abort to propagate
      await new Promise(resolve => setTimeout(resolve, 50));

      // No further LLM calls after dispose
      expect(callerLlm.callCount).toBe(llmCallsBefore);
      expect(callerLlm.callCount).toBeGreaterThan(0); // was actually called

      // No unhandled rejections
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', unhandledHandler);
    }
  });

  it('listen_in off resolves speak immediately (call ends without played acks)', async () => {
    setupTmpDir();

    // Build a simple full call that sends utterances
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      { tools: [{ name: 'say', input: { text: "Hi, I'm an AI assistant. I'd like to book." } }] },
      { tools: [{ name: 'accept_offer', input: { offerId: 'off-1' } }] },
      { tools: [{ name: 'say', input: { text: 'Please book that.' } }] },
      { tools: [{ name: 'end_call', input: { outcome: 'booked', summary: 'Booked' } }] },
    ]);
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      { text: 'Tuesday 9am is available.' },
      { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
      { text: "You're booked!" },
    ]);
    const intakeLlm = fakeLlm([{ text: BRIGHT_SMILE_INTAKE_JSON }]);

    const session = new TestSession(
      makeDeps({
        llms: {
          caller: callerLlm,
          receptionist: recLlm,
          intake: intakeLlm,
          interpret: fakeLlm([]),
        },
      }),
    );

    // listen_in defaults to false — never send any played messages
    await session.handle({ type: 'choose_scenario', scenarioId: 'bright-smile' });
    await session.waitFor('request_understood');
    await session.handle({ type: 'confirm', yes: true });

    // Call should complete without any played acks (listen_in = false → immediate resolve)
    const callEnded = await session.waitFor('call_ended');
    expect(callEnded.outcome.status).toBe('booked');

    // Verify that utterances were emitted (speaks did run)
    const utterances = session.ofType('utterance');
    expect(utterances.length).toBeGreaterThan(0);

    session.dispose();
  });
});
