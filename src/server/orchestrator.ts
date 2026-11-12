/**
 * Call orchestrator: drives the Claude caller agent over a PhoneLine.
 *
 * Owns half-duplex turn-taking, speech bridging (TTS for listen-in, STT for
 * what the caller "hears"), the mid-call user check-in, hard limits, and the
 * final outcome — which is always taken from the clinic's slot book, never
 * from the agent's own claim.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Clinic } from './data.js';
import type { LlmCall } from './llm.js';
import type { PhoneLine, LineEvent, OnLineEvent } from './line/PhoneLine.js';
import type { SpeechProvider } from './speech/SpeechProvider.js';
import type { ServerMsg } from '../shared/protocol.js';
import type { ApprovalKind, CallOutcome, Offer, Speaker, TranscriptLine } from '../shared/types.js';
import { callerToolDefs, execLocal, type CallState } from './agents/callerTools.js';
import { callerSystemPrompt } from './agents/prompts.js';
import { hasContentBeyondYes, interpretAnswer, isClearNo } from './interpret.js';
import { evaluateOffer } from './gate.js';
import { toIcs } from './calendar.js';

export type { SpeechProvider };

type Audio = { audio: Buffer; mime: string } | null;
type Utterance = { id: string; speaker: Speaker; text: string; channel: 'call' | 'user' };

export interface CallIO {
  emit(msg: ServerMsg): void;
  /** Resolves after the client acknowledges playback. */
  speak(u: Utterance, audio: Audio): Promise<void>;
  /** Resolves with the user's answer, or null on timeout. */
  askUser(question: string, timeoutMs: number, attempt: number): Promise<string | null>;
}

export interface CallDeps {
  line: PhoneLine;
  llm: LlmCall;
  interpretLlm: LlmCall;
  speech: SpeechProvider;
  io: CallIO;
  clinic: Clinic;
  now?: () => number;
  /** Today's date (YYYY-MM-DD) for the caller prompt; defaults to the system date. */
  today?: string;
}

export const MAX_ITERATIONS = 40;
export const MAX_CALL_MS = 300_000;
export const CHECKIN_TIMEOUT_MS = 15_000;
export const MAX_CHECKIN_ATTEMPTS = 2;
export const GOODBYE_LINE = "I'm sorry, I'll have to call back later. Goodbye.";
export const NO_ANSWER_RESULT = "No answer from user. Decline politely and say you'll call back.";
export const BOOKING_MISMATCH_NOTE = '(agent reported booked but clinic has no booking)';

const SILENCE = '(silence)';
const NUDGE = 'Please continue using your tools. Call end_call when the call is complete.';
const REFUSAL_SUMMARY =
  "Sorry, the assistant couldn't continue this call, so it was ended. Please try again or call the clinic directly.";
const HANGUP_SUMMARY: Record<Extract<LineEvent, { kind: 'hangup' }>['reason'], string> = {
  receptionist: 'The receptionist ended the call.',
  ivr_disconnect: 'The phone menu disconnected the call.',
  closed: 'The clinic is closed, so no appointment could be booked. Try again during opening hours.',
};

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResultParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type Phase = Extract<ServerMsg, { type: 'call_status' }>['phase'];
type ToolOutput = { content: string; isError?: boolean };

export function runCall(state: CallState, deps: CallDeps, signal: AbortSignal): Promise<CallOutcome> {
  return new Call(state, deps, signal).run();
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error && r.name === 'AbortError' ? r : new DOMException('Call aborted', 'AbortError');
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function describeOffer(o: Offer): string {
  const fee = o.conditions.feeGbp ? `, fee £${o.conditions.feeGbp}` : '';
  const info = o.conditions.requiredInfo?.length ? `, requires: ${o.conditions.requiredInfo.join(', ')}` : '';
  return `[Structured offer ${o.offerId}: ${o.start} to ${o.end}${fee}${info}]`;
}

class Call {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly system: Anthropic.Beta.Messages.BetaTextBlockParam[];
  private readonly transcript: TranscriptLine[] = [];
  private phase: Phase | undefined;
  private utteranceSeq = 0;
  private onHold = false;
  private receptionistConnected = false;
  private disclosed = false;
  private hangup: Extract<LineEvent, { kind: 'hangup' }>['reason'] | undefined;
  private eventQueue: Promise<unknown> = Promise.resolve();
  private readonly handled = new WeakMap<LineEvent, Promise<string[]>>();

  constructor(
    private readonly state: CallState,
    private readonly deps: CallDeps,
    private readonly signal: AbortSignal,
  ) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    const prompt = callerSystemPrompt({ request: state.request, profile: state.profile, today: deps.today ?? localToday() });
    this.system = [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }];
  }

  async run(): Promise<CallOutcome> {
    try {
      return await this.loop();
    } catch (err) {
      if (this.signal.aborted) throw abortError(this.signal);
      throw err;
    }
  }

  private async loop(): Promise<CallOutcome> {
    this.checkAbort();
    this.setPhase('dialing');
    const heard = await this.lineCall(onEvent => this.deps.line.dial(this.signal, onEvent));
    if (this.hangup) return this.finishHangup();
    const messages: MessageParam[] = [{ role: 'user', content: `Call connected. You hear:\n${heard}` }];

    for (let iteration = 0; ; iteration++) {
      this.checkAbort();
      const overTurns = iteration >= MAX_ITERATIONS;
      if (overTurns || this.now() - this.startedAt >= MAX_CALL_MS) {
        await this.sayGoodbye();
        const limit = overTurns ? `the ${MAX_ITERATIONS}-turn limit` : 'the 5-minute call limit';
        return this.finish(this.bookedStatus(), `The call was stopped after reaching ${limit}. Please try again later.`);
      }

      const msg = await this.deps.llm({ max_tokens: 1024, system: this.system, tools: callerToolDefs, messages: [...messages] }, this.signal);
      this.checkAbort();
      if (msg.stop_reason === 'refusal') return this.finish('aborted', REFUSAL_SUMMARY);

      // Response blocks are passed back verbatim (structurally compatible with request blocks)
      messages.push({ role: 'assistant', content: msg.content } as unknown as MessageParam);
      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      if (toolUses.length === 0) {
        const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
        const reply = text ? `You hear:\n${await this.agentSay(text)}` : NUDGE;
        if (this.hangup) return this.finishHangup();
        messages.push({ role: 'user', content: reply });
        continue;
      }

      const results: ToolResultParam[] = [];
      for (const tu of toolUses) {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        if (tu.name === 'end_call') return this.finishEndCall(input);
        const out = await this.runTool(tu.name, input);
        if (this.hangup) return this.finishHangup();
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────

  private async runTool(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    try {
      switch (name) {
        case 'press_keys': {
          const digits = String(input['digits'] ?? '');
          this.deps.io.emit({ type: 'ivr_key', digits });
          this.log('agent', `Pressed ${digits}`, 'ivr_key');
          return { content: await this.lineCall(onEvent => this.deps.line.sendDigits(digits, this.signal, onEvent)) };
        }
        case 'say':
          return { content: await this.agentSay(String(input['text'] ?? '')) };
        case 'wait':
          return { content: SILENCE };
        case 'ask_user':
          return { content: await this.handleAskUser(input) };
        default: {
          const r = execLocal(name, input, this.state, this.deps.line.slotBook());
          if (!r) return { content: `Unhandled tool: ${name}`, isError: true };
          if (r.offerEvent) this.deps.io.emit({ type: 'offer', ...r.offerEvent });
          return { content: r.content, isError: r.isError };
        }
      }
    } catch (err) {
      if (this.signal.aborted) throw err;
      return { content: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async handleAskUser(input: Record<string, unknown>): Promise<string> {
    const question = String(input['question'] ?? '');
    const offerId = typeof input['offerId'] === 'string' ? input['offerId'] : undefined;
    const approvalFor = Array.isArray(input['approvalFor']) ? (input['approvalFor'] as ApprovalKind[]) : [];
    const field = typeof input['field'] === 'string' && input['field'] ? input['field'] : undefined;
    const resumePhase = this.phase ?? 'talking';
    this.setPhase('paused');
    try {
      for (let attempt = 1; attempt <= MAX_CHECKIN_ATTEMPTS; attempt++) {
        this.deps.io.emit({ type: 'needs_user', question, timeoutMs: CHECKIN_TIMEOUT_MS, attempt });
        await this.speakTo('user', 'assistant', question);
        const answer = await this.untilAborted(this.deps.io.askUser(question, CHECKIN_TIMEOUT_MS, attempt));
        if (answer === null || answer.trim() === '') continue; // timeout or empty → re-ask once
        this.log('user', answer);
        const result =
          field !== undefined && approvalFor.length === 0
            ? this.recordInfo(field, answer)
            : await this.recordDecision(answer, question, offerId, approvalFor, field);
        if (result !== undefined) return result;
      }
      return NO_ANSWER_RESULT;
    } finally {
      this.setPhase(resumePhase);
    }
  }

  /**
   * Info request (field, no approvalFor): any non-empty answer that is not a
   * clear "no" IS the info, so a bare "AB123456" counts without needing a yes.
   */
  private recordInfo(field: string, answer: string): string {
    if (isClearNo(answer)) {
      this.state.userAnswers.push({ text: answer });
      return JSON.stringify({ decision: 'no', userSaid: answer });
    }
    this.state.userAnswers.push({ field, text: answer });
    return JSON.stringify({ decision: 'provided', field, userSaid: answer });
  }

  /**
   * Approval (or plain) question: interpretAnswer decides yes/no/unclear, and
   * unclear means re-ask (undefined). If a field is asked for as well ("£20 fee
   * and your insurance number — OK?"), it is recorded only on a yes whose text
   * says more than the yes itself ("yes please" alone supplies no info).
   */
  private async recordDecision(
    answer: string,
    question: string,
    offerId: string | undefined,
    approvalFor: ApprovalKind[],
    field: string | undefined,
  ): Promise<string | undefined> {
    const { decision } = await interpretAnswer(answer, question, this.deps.interpretLlm);
    this.checkAbort();
    const suppliesField = field !== undefined && decision === 'yes' && hasContentBeyondYes(answer);
    this.state.userAnswers.push(suppliesField ? { field, text: answer } : { text: answer });
    if (decision === 'unclear') return undefined;
    if (decision === 'yes' && offerId && approvalFor.length > 0) {
      this.state.approvals.push({ offerId, kinds: approvalFor });
    }
    return JSON.stringify({ decision, userSaid: answer });
  }

  // ─── Line events and speech ─────────────────────────────────────────────────

  /**
   * Runs a line operation. Each event is emitted and spoken the moment the line
   * reports it (onEvent); the returned array is used only to build what the
   * caller heard. Events the line did not report live are handled here.
   */
  private async lineCall(op: (onEvent: OnLineEvent) => Promise<LineEvent[]>): Promise<string> {
    const events = await op(e => void this.handleEvent(e));
    const heard: string[] = [];
    for (const ev of events) heard.push(...(await (this.handled.get(ev) ?? this.handleEvent(ev))));
    return heard.length > 0 ? heard.join('\n') : SILENCE;
  }

  /** Queues an event so UI emission and playback keep line order; resolves to its heard lines. */
  private handleEvent(ev: LineEvent): Promise<string[]> {
    const p = this.eventQueue.then(() => this.processEvent(ev));
    this.eventQueue = p.catch(() => undefined); // also marks p handled if the line call fails first
    this.handled.set(ev, p);
    return p;
  }

  private async processEvent(ev: LineEvent): Promise<string[]> {
    if (ev.kind !== 'hold' && this.onHold) this.endHold();
    switch (ev.kind) {
      case 'ivr':
        this.setPhase('ivr');
        return [`Phone menu: "${await this.hear(ev.text, 'ivr')}"`];
      case 'hold':
        this.setPhase('hold');
        this.onHold = true;
        this.deps.io.emit({ type: 'hold', state: 'start', seconds: ev.seconds });
        this.log('ivr', `On hold (${ev.seconds}s)`, 'hold_start');
        return [`[On hold for ${ev.seconds} seconds]`];
      case 'speech': {
        this.receptionistConnected = true;
        this.setPhase('talking');
        const heard = [`Receptionist: "${await this.hear(ev.text, 'receptionist')}"`];
        if (ev.offer) heard.push(this.noteOffer(ev.offer));
        return heard;
      }
      case 'hangup':
        this.hangup = ev.reason;
        return [];
    }
  }

  private noteOffer(offer: Offer): string {
    this.state.offers.set(offer.offerId, offer);
    const gate = evaluateOffer(offer, this.state.request, this.state.calendar, this.state.approvals);
    this.deps.io.emit({ type: 'offer', offer, gate });
    return describeOffer(offer);
  }

  private endHold(): void {
    this.onHold = false;
    this.deps.io.emit({ type: 'hold', state: 'end' });
    this.log('ivr', 'Off hold', 'hold_end');
  }

  /** Plays line audio to the UI and returns what the caller hears (STT in openai mode). */
  private async hear(text: string, speaker: Speaker): Promise<string> {
    const audio = await this.synthesize(text, speaker);
    this.log(speaker, text);
    const [, heard] = await Promise.all([
      this.untilAborted(this.deps.io.speak({ id: this.nextId(), speaker, text, channel: 'call' }, audio)),
      audio ? this.transcribe(audio, text) : Promise.resolve(text),
    ]);
    return heard;
  }

  /** Agent speech: AI disclosure enforced on the first line to a human receptionist. */
  private async speakAgent(raw: string): Promise<string> {
    let text = raw;
    if (this.receptionistConnected && !this.disclosed) {
      this.disclosed = true;
      if (!/AI assistant/i.test(text)) {
        text = `Hi, I'm an AI assistant calling on behalf of ${this.state.profile.name}. ${text}`;
      }
    }
    await this.speakTo('call', 'agent', text);
    return text;
  }

  private async agentSay(raw: string): Promise<string> {
    const text = await this.speakAgent(raw);
    return this.lineCall(onEvent => this.deps.line.say(text, this.signal, onEvent));
  }

  /** Limit reached: the receptionist still hears the goodbye; its reply is ignored. */
  private async sayGoodbye(): Promise<void> {
    const text = await this.speakAgent(GOODBYE_LINE);
    if (this.hangup) return;
    try {
      await this.deps.line.say(text, this.signal);
    } catch (err) {
      if (this.signal.aborted) throw err;
    }
  }

  private async speakTo(channel: 'call' | 'user', speaker: Speaker, text: string): Promise<void> {
    const audio = await this.synthesize(text, speaker);
    this.log(speaker, text);
    await this.untilAborted(this.deps.io.speak({ id: this.nextId(), speaker, text, channel }, audio));
  }

  private async synthesize(text: string, speaker: Speaker): Promise<Audio> {
    if (this.deps.speech.mode !== 'openai') return null;
    try {
      return await this.deps.speech.synthesize(text, speaker, this.signal);
    } catch (err) {
      if (this.signal.aborted) throw err;
      console.warn('[orchestrator] synthesize failed; falling back to text:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async transcribe(audio: NonNullable<Audio>, fallback: string): Promise<string> {
    try {
      const text = await this.deps.speech.transcribe(audio.audio, audio.mime, this.signal);
      return text.trim() || fallback;
    } catch (err) {
      if (this.signal.aborted) throw err;
      console.warn('[orchestrator] transcribe failed; passing text through:', err instanceof Error ? err.message : err);
      return fallback;
    }
  }

  // ─── Ending ─────────────────────────────────────────────────────────────────

  private bookedStatus(): 'booked' | 'not_booked' {
    return this.deps.line.slotBook().booked() ? 'booked' : 'not_booked';
  }

  private finishEndCall(input: Record<string, unknown>): CallOutcome {
    const status = this.bookedStatus();
    const summary = String(input['summary'] ?? '');
    const mismatch = input['outcome'] === 'booked' && status !== 'booked';
    return this.finish(status, mismatch ? `${summary} ${BOOKING_MISMATCH_NOTE}`.trim() : summary);
  }

  private finishHangup(): CallOutcome {
    const booking = this.deps.line.slotBook().booked();
    const reason = HANGUP_SUMMARY[this.hangup ?? 'receptionist'];
    const summary = booking ? `Booked ${booking.clinicName} for ${booking.start}. ${reason}` : reason;
    return this.finish(this.bookedStatus(), summary);
  }

  private finish(status: CallOutcome['status'], summary: string): CallOutcome {
    if (this.onHold) this.endHold();
    const booking = this.deps.line.slotBook().booked();
    const outcome: CallOutcome = { status, summary, transcript: this.transcript, ...(booking ? { booking } : {}) };
    this.setPhase('ended');
    const ics = status === 'booked' && booking ? toIcs(booking, this.state.profile.name) : undefined;
    this.deps.io.emit({ type: 'call_ended', outcome, ...(ics ? { ics } : {}) });
    return outcome;
  }

  // ─── Small utilities ────────────────────────────────────────────────────────

  private setPhase(phase: Phase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.deps.io.emit({ type: 'call_status', phase });
  }

  private log(speaker: Speaker, text: string, meta?: string): void {
    this.transcript.push({ at: this.now(), speaker, text, ...(meta ? { meta } : {}) });
  }

  private nextId(): string {
    return `u${++this.utteranceSeq}`;
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw abortError(this.signal);
  }

  /** Rejects as soon as the call is aborted, even if `p` never settles. */
  private untilAborted<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal.aborted) return reject(abortError(this.signal));
      const onAbort = () => reject(abortError(this.signal));
      this.signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        v => {
          this.signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        e => {
          this.signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }
}
