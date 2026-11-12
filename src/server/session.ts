/**
 * Session: per-WebSocket state machine that drives intake → confirming → calling → done.
 *
 * Implements the CallIO interface (emit, speak, askUser) so it can be passed
 * directly to runCall without an intermediate adapter.
 */
import type { ServerMsg, ClientMsg } from '../shared/protocol.js';
import type { Config } from './config.js';
import type { Clinic, Profile } from './data.js';
import type { LlmCall } from './llm.js';
import type { SpeechProvider } from './speech/SpeechProvider.js';
import type { Speaker, BookingRequest } from '../shared/types.js';
import type { CallIO, CallDeps } from './orchestrator.js';
import { Intake } from './agents/intake.js';
import { interpretAnswer } from './interpret.js';
import { runCall } from './orchestrator.js';
import { SimulatedLine } from './line/SimulatedLine.js';
import { loadCalendar } from './data.js';
import { appendBooking } from './calendar.js';
import type { CallState } from './agents/callerTools.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SessionDeps {
  config: Config;
  clinics: Clinic[];
  profile: Profile;
  /**
   * Base data directory (contains calendar.json and receives calendar.bookings.json).
   * Equivalent to the `data/` folder at the project root in production.
   */
  dataDir: string;
  llms: {
    /** Caller-agent LLM (with server-side-fallback beta). */
    caller: LlmCall;
    /** Simulated receptionist LLM. */
    receptionist: LlmCall;
    /** Intake extraction LLM. */
    intake: LlmCall;
    /** Answer-interpretation LLM (yes/no/unclear). */
    interpret: LlmCall;
  };
  speech: SpeechProvider;
  /** Abortable sleep — injectable for tests (default: real setTimeout). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type State = 'idle' | 'intake' | 'confirming' | 'calling' | 'done';

// ─── Session ──────────────────────────────────────────────────────────────────

export class Session {
  private state: State = 'idle';
  private readonly send: (m: ServerMsg) => void;
  private readonly deps: SessionDeps;

  // Listen-in preference (whether to wait for played acks during call speaks)
  private listenIn = false;

  // ID counter for session-generated utterances
  private utSeq = 0;

  // Intake phase state
  private intake: Intake | null = null;
  private pendingRequest: BookingRequest | null = null;
  private pendingClinic: Clinic | null = null;

  // Calling phase state
  private callAbort: AbortController | null = null;

  // Pending resolvers for CallIO.speak (call channel)
  private readonly pendingPlayed = new Map<string, () => void>();
  private readonly pendingPlayedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Pending resolver for CallIO.askUser
  private pendingUserAnswer: ((ans: string | null) => void) | null = null;
  private pendingUserAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * User answer that arrived while in calling state before askUser set up its resolver.
   * Happens because handleAskUser emits needs_user, awaits speakTo, then calls io.askUser —
   * the client may respond between the emit and the io.askUser call (microtask boundary).
   */
  private bufferedUserAnswer: string | null = null;
  /**
   * True while a needs_user event has been emitted and askUserForCall has not yet consumed it.
   * Only utterances received in this window are buffered; all others in calling state are
   * silently dropped so they cannot pre-approve a future question.
   */
  private needsUserPending: boolean = false;

  constructor(send: (m: ServerMsg) => void, deps: SessionDeps) {
    this.send = send;
    this.deps = deps;

    // Send hello on construction
    send({
      type: 'hello',
      speechMode: deps.config.speechMode,
      scenarios: deps.clinics.map(c => ({
        id: c.id,
        label: c.name,
        requestText: c.demoRequest,
      })),
    });
  }

  /** Handle a message from the client. Invalid-state messages send error{message} without throwing. */
  async handle(msg: ClientMsg): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'error', message });
    }
  }

  /** Abort any running call and clear all pending timers/resolvers. */
  dispose(): void {
    if (this.callAbort) {
      this.callAbort.abort(new DOMException('Session disposed', 'AbortError'));
      this.callAbort = null;
    }

    // Resolve all pending played acks (so speak() can return without leaking)
    for (const resolve of this.pendingPlayed.values()) {
      resolve();
    }
    this.pendingPlayed.clear();
    for (const timer of this.pendingPlayedTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingPlayedTimers.clear();

    // Resolve any pending user-answer waiter
    if (this.pendingUserAnswer !== null) {
      const resolve = this.pendingUserAnswer;
      this.pendingUserAnswer = null;
      if (this.pendingUserAnswerTimer !== null) {
        clearTimeout(this.pendingUserAnswerTimer);
        this.pendingUserAnswerTimer = null;
      }
      resolve(null);
    }
    this.bufferedUserAnswer = null;
    this.needsUserPending = false;
  }

  // ─── Dispatcher ─────────────────────────────────────────────────────────────

  private async dispatch(msg: ClientMsg): Promise<void> {
    switch (msg.type) {
      case 'listen_in':
        this.listenIn = msg.on;
        break;

      case 'played': {
        const resolve = this.pendingPlayed.get(msg.id);
        if (resolve) {
          this.pendingPlayed.delete(msg.id);
          const timer = this.pendingPlayedTimers.get(msg.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingPlayedTimers.delete(msg.id);
          }
          resolve();
        }
        break;
      }

      case 'reset':
        if (this.state === 'calling') {
          this.send({ type: 'error', message: 'Cannot reset during a call' });
          return;
        }
        this.doReset();
        break;

      case 'user_utterance':
        await this.handleUserUtterance(msg);
        break;

      case 'choose_scenario':
        await this.handleChooseScenario(msg.scenarioId);
        break;

      case 'confirm':
        await this.handleConfirm(msg.yes);
        break;
    }
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private async handleUserUtterance(msg: Extract<ClientMsg, { type: 'user_utterance' }>): Promise<void> {
    // During a call, route to any pending askUser resolver or buffer for the
    // race window where needs_user was emitted but io.askUser hasn't been called yet.
    if (this.state === 'calling') {
      const text = msg.text ?? '';
      if (this.pendingUserAnswer !== null) {
        const resolve = this.pendingUserAnswer;
        this.pendingUserAnswer = null;
        if (this.pendingUserAnswerTimer !== null) {
          clearTimeout(this.pendingUserAnswerTimer);
          this.pendingUserAnswerTimer = null;
        }
        resolve(text);
      } else if (this.needsUserPending) {
        // Race window: needs_user was emitted but askUser hasn't set up its resolver yet.
        this.bufferedUserAnswer = text;
        this.needsUserPending = false;
      }
      // else: no active needs_user — ignore the utterance so it cannot pre-approve a future question
      return;
    }

    // In confirming state, treat utterance as a spoken yes/no
    if (this.state === 'confirming') {
      const text = msg.text ?? '';
      await this.handleSpokenConfirm(text);
      return;
    }

    if (this.state !== 'idle' && this.state !== 'intake') {
      this.send({ type: 'error', message: `user_utterance not valid in state ${this.state}` });
      return;
    }

    // Resolve text (transcribe audio if openai mode)
    let text: string;
    if (msg.text !== undefined) {
      text = msg.text;
    } else if (
      msg.audioB64 !== undefined &&
      msg.mime !== undefined &&
      this.deps.config.speechMode === 'openai'
    ) {
      const audio = Buffer.from(msg.audioB64, 'base64');
      text = await this.deps.speech.transcribe(audio, msg.mime);
    } else {
      this.send({ type: 'error', message: 'No text in utterance' });
      return;
    }

    this.state = 'intake';

    if (!this.intake) {
      this.intake = new Intake(
        this.deps.clinics,
        this.deps.profile,
        this.deps.config.today,
        this.deps.llms.intake,
      );
    }

    const result = await this.intake.hear(text);

    if (result.kind === 'question') {
      this.speakToUser('assistant', result.question);
    } else {
      this.pendingRequest = result.request;
      this.pendingClinic =
        this.deps.clinics.find(c => c.id === result.request.clinicId) ?? null;

      this.send({ type: 'request_understood', request: result.request, summary: result.summary });

      this.speakToUser('assistant', `${result.summary}. Shall I call them now?`);
      this.state = 'confirming';
    }
  }

  private async handleChooseScenario(scenarioId: string): Promise<void> {
    if (this.state === 'calling') {
      this.send({ type: 'error', message: 'Cannot choose scenario during a call' });
      return;
    }

    const clinic = this.deps.clinics.find(c => c.id === scenarioId);
    if (!clinic) {
      this.send({ type: 'error', message: `Unknown scenario: ${scenarioId}` });
      return;
    }

    // Reset intake and replay as a user utterance
    this.intake = null;
    this.pendingRequest = null;
    this.pendingClinic = null;
    this.state = 'idle';

    await this.handleUserUtterance({ type: 'user_utterance', text: clinic.demoRequest });
  }

  private async handleConfirm(yes: boolean): Promise<void> {
    if (this.state !== 'confirming') {
      this.send({ type: 'error', message: `confirm not valid in state ${this.state}` });
      return;
    }

    if (yes) {
      this.startCall();
    } else {
      this.speakToUser('assistant', 'Okay, cancelled.');
      this.doReset();
    }
  }

  /** Interpret a spoken yes/no answer in the confirming state. */
  private async handleSpokenConfirm(text: string): Promise<void> {
    const { decision } = await interpretAnswer(
      text,
      'Shall I call them now?',
      this.deps.llms.interpret,
    );

    if (decision === 'yes') {
      this.startCall();
    } else if (decision === 'no') {
      this.speakToUser('assistant', 'Okay, cancelled.');
      this.doReset();
    }
    // 'unclear' — stay in confirming state, wait for clarification
  }

  // ─── Call lifecycle ──────────────────────────────────────────────────────────

  /** Fire-and-forget call runner. All errors are caught by the promise chain. */
  private startCall(): void {
    if (!this.pendingRequest || !this.pendingClinic) return;

    const request = this.pendingRequest;
    const clinic = this.pendingClinic;

    this.state = 'calling';

    const calendar = loadCalendar(this.deps.dataDir, this.deps.config.today);
    const callState: CallState = {
      request,
      profile: this.deps.profile,
      calendar,
      approvals: [],
      offers: new Map(),
      userAnswers: [],
    };

    const line = new SimulatedLine(clinic, this.deps.profile, this.deps.llms.receptionist, {
      holdScale: this.deps.config.holdScale,
      sleep: this.deps.sleep,
      today: this.deps.config.today,
    });

    const session = this;
    const io: CallIO = {
      emit: msg => {
        if (msg.type === 'needs_user') session.needsUserPending = true;
        session.send(msg);
      },
      speak: (u, audio) => session.speakCall(u, audio),
      askUser: (q, timeoutMs, attempt) => session.askUserForCall(q, timeoutMs, attempt),
    };

    const callDeps: CallDeps = {
      line,
      llm: this.deps.llms.caller,
      interpretLlm: this.deps.llms.interpret,
      speech: this.deps.speech,
      io,
      clinic,
      today: this.deps.config.today,
    };

    this.callAbort = new AbortController();
    const signal = this.callAbort.signal;

    runCall(callState, callDeps, signal).then(
      outcome => {
        // callAbort might have been nulled by dispose()
        this.callAbort = null;
        if (outcome.status === 'booked' && outcome.booking) {
          try {
            appendBooking(this.deps.dataDir, outcome.booking);
          } catch (err) {
            console.warn('[session] appendBooking failed:', err);
          }
        }
        this.state = 'done';
      },
      err => {
        this.callAbort = null;
        if ((err as { name?: string })?.name !== 'AbortError') {
          // Non-abort error: surface to client and emit a synthetic call_ended
          const message = err instanceof Error ? err.message : String(err);
          this.send({ type: 'error', message });
          this.send({
            type: 'call_ended',
            outcome: { status: 'aborted', summary: message, transcript: [] },
          });
        }
        // For AbortError the orchestrator will not have emitted call_ended either,
        // but the session already transitions to done and the client can recover via reset.
        this.state = 'done';
      },
    );
  }

  // ─── CallIO helpers ──────────────────────────────────────────────────────────

  /**
   * Send an utterance to the user channel.  Synthesizes audio in openai mode.
   * Fire-and-forget: does not wait for played ack (the UI drives timing).
   */
  private speakToUser(speaker: Speaker, text: string): void {
    const id = this.nextId();

    if (this.deps.config.speechMode === 'openai') {
      // Synthesize asynchronously; fall back to text-only on failure
      this.deps.speech.synthesize(text, speaker).then(
        audio => {
          this.send({
            type: 'utterance',
            id,
            speaker,
            text,
            channel: 'user',
            ...(audio ? { audioB64: audio.audio.toString('base64'), mime: audio.mime } : {}),
          });
        },
        () => {
          this.send({ type: 'utterance', id, speaker, text, channel: 'user' });
        },
      );
    } else {
      this.send({ type: 'utterance', id, speaker, text, channel: 'user' });
    }
  }

  /**
   * CallIO.speak implementation: send utterance and optionally wait for played ack.
   * Resolves immediately when listen-in is off.
   * Resolves on played{id} or after max(3000, words*450)+2000 ms when listen-in is on.
   */
  private async speakCall(
    u: { id: string; speaker: Speaker; text: string; channel: 'call' | 'user' },
    audio: { audio: Buffer; mime: string } | null,
  ): Promise<void> {
    this.send({
      type: 'utterance',
      id: u.id,
      speaker: u.speaker,
      text: u.text,
      channel: u.channel,
      ...(audio ? { audioB64: audio.audio.toString('base64'), mime: audio.mime } : {}),
    });

    if (!this.listenIn) return;

    await this.waitForPlayed(u.id, u.text);
  }

  private waitForPlayed(id: string, text: string): Promise<void> {
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    const timeoutMs = Math.max(3000, wordCount * 450) + 2000;

    return new Promise<void>(resolve => {
      this.pendingPlayed.set(id, resolve);

      const timer = setTimeout(() => {
        if (this.pendingPlayed.get(id) === resolve) {
          this.pendingPlayed.delete(id);
          this.pendingPlayedTimers.delete(id);
          resolve();
        }
      }, timeoutMs);
      this.pendingPlayedTimers.set(id, timer);
    });
  }

  /**
   * CallIO.askUser implementation: wait for the next user_utterance in calling
   * state, or time out after timeoutMs ms.
   *
   * NOTE: the orchestrator (handleAskUser) already emits needs_user via io.emit
   * before calling this method, so we must NOT re-send it here — that would cause
   * a duplicate message on the wire.
   *
   * RACE WINDOW: handleAskUser does io.emit(needs_user) → await speakTo() → io.askUser().
   * The client may respond between the emit and this call (microtask boundary after
   * speakTo). If that happens, handleUserUtterance buffers the answer in
   * bufferedUserAnswer and we consume it immediately here.
   */
  private askUserForCall(_question: string, timeoutMs: number, _attempt: number): Promise<string | null> {
    // askUser has been called — clear the pending flag (the buffer was already populated or not)
    this.needsUserPending = false;
    // Consume a buffered answer that arrived before we set up pendingUserAnswer
    if (this.bufferedUserAnswer !== null) {
      const answer = this.bufferedUserAnswer;
      this.bufferedUserAnswer = null;
      return Promise.resolve(answer);
    }

    return new Promise<string | null>(resolve => {
      this.pendingUserAnswer = resolve;

      this.pendingUserAnswerTimer = setTimeout(() => {
        if (this.pendingUserAnswer === resolve) {
          this.pendingUserAnswer = null;
          this.pendingUserAnswerTimer = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  private doReset(): void {
    this.state = 'idle';
    this.intake = null;
    this.pendingRequest = null;
    this.pendingClinic = null;
    this.bufferedUserAnswer = null;
    this.needsUserPending = false;
  }

  private nextId(): string {
    return `s${++this.utSeq}`;
  }
}
