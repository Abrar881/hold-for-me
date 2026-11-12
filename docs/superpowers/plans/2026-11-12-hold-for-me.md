# Hold For Me Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app where a user speaks a clinic-booking request and a Claude-powered voice agent phones a simulated clinic (phone menu, hold, receptionist), checks back with the user by voice when needed, and returns a confirmed booking.

**Architecture:** Node/TypeScript server owns all logic. The server includes a simulated phone line (deterministic IVR, hold, Claude receptionist over a scripted slot book), a Claude caller agent whose offer acceptance passes through a code gate, and a pluggable speech layer: OpenAI STT/TTS, or browser Web Speech fallback. A React page talks to the server over one WebSocket. A CLI runs whole calls in text mode for smoke tests.

**Tech Stack:** Node ≥ 20, TypeScript (ESM), `@anthropic-ai/sdk`, `openai` (speech only), `zod`, Fastify + `@fastify/websocket` + `@fastify/static`, React 18 + Vite, Vitest, `tsx`, `concurrently`, `dotenv`.

**Spec:** `docs/superpowers/specs/2026-11-12-hold-for-me-design.md`

## Global Constraints

- **Commits:** the author has delegated commits. Each "Commit (author)" step means the implementer commits the task's files with the suggested message (Conventional Commits). Never push; never commit `.env`.
- Runs with `npm install` → `.env` containing `ANTHROPIC_API_KEY` → `npm run dev`. `OPENAI_API_KEY` is optional; it switches speech mode to `openai`.
- Secrets only in `.env` (git-ignored); `.env.example` committed.
- Models from env: `CALLER_MODEL` default `claude-sonnet-5-5`, `RECEPTIONIST_MODEL` default `claude-haiku-5-5`, `INTERPRET_MODEL` default `claude-haiku-5-5`. Never append date suffixes.
- Claude 5.5 rules: send no `temperature`/`top_p`/`top_k`; no forced `tool_choice` (`auto` only); no assistant prefill; set `output_config.effort` explicitly (default `low`, env `CALLER_EFFORT` / `RECEPTIONIST_EFFORT`); check `stop_reason === "refusal"` before reading content.
- Caller-agent requests use `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`.
- Prompt caching: `cache_control: { type: "ephemeral" }` on the last system block of every agent.
- Times are local, timezone-less strings: dates `YYYY-MM-DD`, times `HH:MM`, datetimes `YYYY-MM-DDTHH:MM`. "Today" = `TODAY` env if set (for demos) else the system date.
- AI disclosure: the first caller utterance to a human receptionist must contain "AI assistant" (enforced in code, Task 11).
- Hard limits: 40 caller-agent iterations, 300 s call duration, 15 s user check-in timeout, max 2 check-in attempts per question.
- Per-turn latency target ≈ 4 s; UI shows "thinking/speaking" indicators.
- Fallback (browser) speech requires Chrome/Edge; README says so.

## Review Focus

1. **Ambiguous check-in answer** ("uh, what time was it?"): must be classified `unclear`, never counted as approval; the agent re-asks once, then declines politely. → tests in Task 7 and Task 11.
2. **Speech provider fails mid-call** (OpenAI 5xx/timeout on TTS or STT): that utterance degrades to text (browser speaks it / text passed directly), and the call continues. → test in Task 11.
3. **Browser disconnects mid-call** (tab closed): server aborts the agent loop and hold timers via `AbortSignal`, with no unhandled rejections and no further LLM calls. → test in Task 14.
4. **Receptionist goes off-script** (says a time verbally without `make_offer`, or the caller references an unknown offer): `accept_offer` with an unknown `offerId` returns an error; the booking card is built only from the slot book. → tests in Tasks 6 and 11.
5. **No mic / no Web Speech support / permission denied**: UI shows a clear notice and a text box plus Confirm/Decline buttons, so the flow still completes. → test in Task 15 (`detectCapabilities`).

---

## File Structure

```
package.json  tsconfig.json  vite.config.ts  vitest.config.ts  .env.example  .gitignore
data/
  profile.json  calendar.json
  clinics/bright-smile.json  clinics/clearview.json  clinics/riverside.json  (+ clinics/sunny-eyes.json in Task 18)
src/shared/
  types.ts        domain types shared by server + web
  protocol.ts     WebSocket message unions
src/server/
  config.ts       env → Config
  dates.ts        relative date resolution, weekday helpers
  data.ts         zod schemas + loaders for data/ files
  calendar.ts     clash checks, append booking, .ics export
  gate.ts         offer acceptance gate (guardrails)
  llm.ts          LlmCall type + Anthropic implementation
  interpret.ts    yes/no/unclear classifier for user answers
  line/PhoneLine.ts       interface
  line/ivr.ts             IVR state machine
  line/slotBook.ts        per-call slot book
  line/receptionist.ts    Claude receptionist
  line/SimulatedLine.ts   PhoneLine impl composing the above
  agents/prompts.ts       system prompts
  agents/callerTools.ts   caller tool schemas + executors
  agents/intake.ts        spoken request → BookingRequest
  orchestrator.ts         caller agent loop, CallIO, limits, speech bridging
  speech/SpeechProvider.ts  interface + factory
  speech/openai.ts          OpenAI STT/TTS
  session.ts      per-WebSocket state machine
  index.ts        Fastify server
src/cli/scenario.ts       text-mode runner
src/web/
  index.html  main.tsx  App.tsx  ws.ts  audio.ts  tones.ts  capabilities.ts  browserSpeech.ts  recorder.ts
  components/RequestPanel.tsx  CallPanel.tsx  CheckIn.tsx  ResultCard.tsx
  styles.css
tests/ (mirrors src/server; helpers/fakeLlm.ts, helpers/fakeIo.ts)
README.md  ai.md  WRITEUP.md
```

---

### Task 1: Scaffold, shared types, config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`, `src/shared/types.ts`, `src/shared/protocol.ts`, `src/server/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: all types below; `loadConfig(env: NodeJS.ProcessEnv): Config`.

- [ ] **Step 1: Scaffold.** `npm init`; install the deps from Tech Stack. Scripts:
  - `dev` = `concurrently "tsx watch src/server/index.ts" "vite"`
  - `build` = `vite build`
  - `start` = `tsx src/server/index.ts`
  - `test` = `vitest run`
  - `scenario` = `tsx src/cli/scenario.ts`
  - `typecheck` = `tsc --noEmit`

  `"type": "module"`. Vite root `src/web`, dev proxy `/ws` → `ws://localhost:3001`. `.gitignore` includes `.env`, `node_modules`, `dist`, `data/calendar.bookings.json`.

  `.env.example` lists: `ANTHROPIC_API_KEY=`, `OPENAI_API_KEY=`, `CALLER_MODEL`, `RECEPTIONIST_MODEL`, `INTERPRET_MODEL`, `CALLER_EFFORT`, `RECEPTIONIST_EFFORT`, `TODAY`, `HOLD_SCALE=1`, `PORT=3001`.

- [ ] **Step 2: Write `src/shared/types.ts`** (contract for every later task):

```ts
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
```

- [ ] **Step 3: Write `src/shared/protocol.ts`.** Discriminated unions on `type`:
  - `ServerMsg`:
    - `hello{speechMode, scenarios:{id,label,requestText}[]}`
    - `utterance{id, speaker, text, channel:'call'|'user', audioB64?, mime?}`
    - `request_understood{request:BookingRequest, summary}`
    - `call_status{phase:'dialing'|'ivr'|'hold'|'talking'|'paused'|'ended'}`
    - `ivr_key{digits}`
    - `hold{state:'start'|'end', seconds?}`
    - `needs_user{question, timeoutMs, attempt}`
    - `offer{offer:Offer, gate:GateResult}`
    - `call_ended{outcome:CallOutcome, ics?:string}`
    - `error{message}`
  - `ClientMsg`:
    - `user_utterance{text?, audioB64?, mime?}`
    - `choose_scenario{scenarioId}`
    - `confirm{yes:boolean}`
    - `played{id}`
    - `listen_in{on:boolean}`
    - `reset`

- [ ] **Step 4: Write failing tests** `tests/config.test.ts`:
  - `selects openai speech when OPENAI_API_KEY set`: `loadConfig({ANTHROPIC_API_KEY:'a', OPENAI_API_KEY:'o'}).speechMode === 'openai'`
  - `falls back to browser speech without OPENAI_API_KEY`: `speechMode === 'browser'`
  - `throws a clear error without ANTHROPIC_API_KEY`: message contains `ANTHROPIC_API_KEY`
  - `applies model defaults`: `callerModel === 'claude-sonnet-5-5'`, `receptionistModel === 'claude-haiku-5-5'`, `callerEffort === 'low'`
  - `uses TODAY override`: `loadConfig({..., TODAY:'2026-11-12'}).today === '2026-11-12'`
  - `HOLD_SCALE parses to number, default 1`

- [ ] **Step 5: Run** `npx vitest run tests/config.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 6: Implement `loadConfig(env): Config`** in `src/server/config.ts`. `Config` fields:
  - `anthropicKey`, `openaiKey?`, `speechMode`
  - `callerModel`, `receptionistModel`, `interpretModel`
  - `callerEffort`, `receptionistEffort` (`'low'|'medium'|'high'`)
  - `today`, `holdScale`, `port`

- [ ] **Step 7: Run** `npx vitest run tests/config.test.ts && npx tsc --noEmit`. Expected: PASS, no type errors.

- [ ] **Step 8: Commit (author).** Suggested message: `chore: scaffold project, shared types and config`

---

### Task 2: Relative dates + data files + loaders

Slot books and calendars must stay valid whenever judges run the app, so data files use **relative** dates resolved against `today`.

**Files:**
- Create: `src/server/dates.ts`, `src/server/data.ts`, `data/profile.json`, `data/calendar.json`, `data/clinics/{bright-smile,clearview,riverside}.json`
- Test: `tests/dates.test.ts`, `tests/data.test.ts`

**Interfaces:**
- Produces:
  - `RelTime = { weekOffset: number; weekday: number; time: string }`. `weekOffset` 0 = this ISO week (Mon-start), 1 = next.
  - `resolveRel(r: RelTime, today: string): string` returns `YYYY-MM-DDTHH:MM`.
  - `weekRange(weekOffset: number, today: string): { from: string; to: string }` (Mon..Sun).
  - `weekdayOf(date: string): number`.
  - `loadProfile(dir, today): Profile`; `loadCalendar(dir, today): CalendarEvent[]`; `loadClinics(dir, today): Clinic[]`.
  - `Profile = { name: string; dob: string; phone: string; existingPatientAt: string[]; fields: Record<string,string> }`. `fields` deliberately has **no** `insuranceNumber`.
  - `Clinic`:
    - `id`, `name`, `service`, `receptionistName`, `persona`, `holdSeconds`
    - `ivr: IvrNode[]`
    - `slots: Slot[]` (resolved, in scripted offer order; durations from `durationMin`)
    - `quirks: { asksDob?: boolean; newPatientFeeGbp?: number; requiresInfoForNewPatients?: string[] }`
    - `demoRequest: string`
  - `IvrNode = { id: string; prompt: string; options: Record<string,string>; terminal?: 'hold'|'receptionist'|'closed' }`.

- [ ] **Step 1: Write failing tests** `tests/dates.test.ts` (today `2026-11-12`, a Thursday):
  - `resolveRel({weekOffset:1, weekday:2, time:'09:00'}, '2026-11-12') === '2026-11-17T09:00'`
  - `resolveRel({weekOffset:0, weekday:5, time:'14:30'}, ...) === '2026-11-13T14:30'`
  - `weekRange(1, '2026-11-12')` → `{from:'2026-11-16', to:'2026-11-22'}`
  - `weekRange` when today is Sunday `2026-11-15`, offset 1 → `{from:'2026-11-16', ...}`
  - `weekdayOf('2026-11-19') === 4`

- [ ] **Step 2: Run** `npx vitest run tests/dates.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/server/dates.ts`.** Use UTC-based `Date` arithmetic on date-only values so the host timezone never shifts days.

- [ ] **Step 4: Write data files.** Clinic JSON slot entries are `{ slotId, rel: RelTime, durationMin }` in offer order. Values pinned by spec §7:
  - `profile.json`:
    - name `Alex Khan`, dob `1998-04-03`, phone `07700 900123`
    - `existingPatientAt: ["bright-smile","clearview"]`
    - `fields: { address: "12 Elm Road, Leeds" }`
  - `calendar.json`: event `Team stand-up`, next week Tue 09:00–10:00 (`{weekOffset:1, weekday:2}`).
  - `bright-smile.json` (Bright Smile Dental):
    - receptionist `Sarah`; `asksDob: true`; `holdSeconds: 8`
    - IVR: root "Thanks for calling Bright Smile Dental. For appointments press 1, for billing press 2." `1`→`hold-node` (terminal `hold`), `2`→`billing` (terminal `closed`)
    - slots in order: next-week Tue 09:00 (clashes with stand-up), next-week Thu 10:30, next-week Fri 11:00
    - `demoRequest`: "Book me a check-up at Bright Smile next week, mornings, not Wednesday."
  - `clearview.json` (Clearview Opticians):
    - receptionist `Priya`; `holdSeconds: 5`
    - IVR: root "Clearview Opticians. To book an eye test press 1, for collections press 2." `1`→receptionist
    - slots: next-week Thu 15:00, then week+2 Mon 09:30
    - `demoRequest`: "Get me an eye test at Clearview next week, mornings please."
  - `riverside.json` (Riverside Dental):
    - receptionist `Tom`; `newPatientFeeGbp: 20`; `requiresInfoForNewPatients: ["insuranceNumber"]`; no IVR beyond a root that goes straight to receptionist; `holdSeconds: 3`
    - slots: next-week Wed 10:00, next-week Fri 09:30
    - `demoRequest`: "Register me at Riverside Dental and book a check-up next week, any morning."

- [ ] **Step 5: Write failing tests** `tests/data.test.ts`:
  - `loads three clinics with resolved slots`: bright-smile `slots[0].start === '2026-11-17T09:00'` and `end === '2026-11-17T09:30'` (durationMin 30)
  - `rejects a clinic whose IVR option points to a missing node` (zod refine; write temp dir fixture)
  - `profile has no insuranceNumber field`
  - `calendar resolves stand-up to 2026-11-17T09:00–10:00`

- [ ] **Step 6: Run, implement `src/server/data.ts`** (zod schemas, `fs.readFileSync`, resolve rel dates), **run again.** Command: `npx vitest run tests/data.test.ts tests/dates.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit (author).** `feat: relative-date data model and clinic scenarios`

---

### Task 3: Calendar

**Files:** Create `src/server/calendar.ts`; Test `tests/calendar.test.ts`

**Interfaces:**
- Produces:
  - `overlaps(a: {start,end}, b: {start,end}): boolean`
  - `clashes(slot: Slot, events: CalendarEvent[]): CalendarEvent[]`
  - `busyBetween(events, from: string, to: string): CalendarEvent[]`
  - `appendBooking(dir: string, booking: Booking): void` (writes `data/calendar.bookings.json`; `loadCalendar` must also merge this file)
  - `toIcs(booking: Booking, profileName: string): string`

- [ ] **Step 1: Failing tests:**
  - `back-to-back is not a clash`: 10:00–10:30 vs 09:00–10:00 → `[]`
  - `partial overlap clashes`: 09:30–10:00 vs stand-up → length 1
  - `busyBetween filters by date range inclusive`
  - `toIcs contains DTSTART:20261119T103000 and SUMMARY with clinic name`
  - `appendBooking then loadCalendar includes booking` (temp dir)

- [ ] **Step 2: Run** `npx vitest run tests/calendar.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** ISO-like strings compare lexicographically, so no Date needed for overlap. `.ics` uses floating local time (no `Z`), CRLF line endings.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: calendar clash detection and ics export`

---

### Task 4: Offer gate (the guardrail)

**Files:** Create `src/server/gate.ts`; Test `tests/gate.test.ts`

**Interfaces:**
- Consumes: `BookingRequest`, `Offer`, `CalendarEvent`, `Approval` (Task 1), `clashes` (Task 3), `weekdayOf` (Task 2).
- Produces: `evaluateOffer(offer: Offer | undefined, req: BookingRequest, calendar: CalendarEvent[], approvals: Approval[]): GateResult`.

Rules, applied in this order with all failing reasons collected:
1. `undefined` → `unknown_offer`.
2. Date outside `dateFrom..dateTo` → `outside_dates`.
3. Start before `timeWindow.start`, or end after `timeWindow.end` → `outside_time_window`.
4. Weekday in `excludedWeekdays` → `excluded_day`.
5. Calendar clash → `calendar_clash`.
6. `conditions.feeGbp > 0` without approval kind `fee` for this `offerId` → `fee_unapproved`.

A `slot` approval for this `offerId` waives reasons 2–4, but **never** `calendar_clash`, because the user approved the time without seeing the clash. A `fee` approval waives only reason 6.

- [ ] **Step 1: Failing tests** (request: 2026-11-16..22, 08:00–12:00, excluded `[3]`):
  - `accepts in-window morning slot` → `{ok:true}`
  - `rejects Thu 15:00 as outside_time_window`
  - `rejects Wednesday as excluded_day`
  - `rejects clash with stand-up`
  - `rejects unapproved £20 fee`; `accepts fee once approved`
  - `slot approval waives time window but not calendar clash`
  - `approval for a different offerId does not apply`
  - `unknown offer returns unknown_offer`
  - `collects multiple reasons` (Wed 15:00 → both `outside_time_window` and `excluded_day`)

- [ ] **Step 2: Run** `npx vitest run tests/gate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `evaluateOffer` as specified.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: offer acceptance gate enforcing user rules`

---

### Task 5: IVR state machine

**Files:** Create `src/server/line/ivr.ts`; Test `tests/ivr.test.ts`

**Interfaces:**
- Produces: `class Ivr { constructor(nodes: IvrNode[]); current(): IvrNode; press(digits: string): IvrStep }` where `IvrStep = { kind: 'prompt'; text: string } | { kind: 'terminal'; terminal: 'hold'|'receptionist'|'closed'; text?: string } | { kind: 'invalid'; text: string } | { kind: 'disconnected'; text: string }`. The first node is the root.

- [ ] **Step 1: Failing tests** (bright-smile IVR):
  - `press 1 reaches hold terminal`
  - `invalid key re-prompts with "Sorry, that's not a valid option." + root prompt`
  - `three invalid presses disconnect`
  - `multi-digit string presses each digit in order`
  - `press on a terminal node is a no-op invalid`

- [ ] **Step 2: Run** `npx vitest run tests/ivr.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `Ivr`.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: deterministic IVR state machine`

---

### Task 6: Slot book

**Files:** Create `src/server/line/slotBook.ts`; Test `tests/slotBook.test.ts`

**Interfaces:**
- Consumes: `Clinic`, `Profile`, `Offer`.
- Produces: `class SlotBook`:
  - `constructor(clinic: Clinic, isNewPatient: boolean)`
  - `list(from: string, to: string): Slot[]` returns available slots in **scripted order**
  - `makeOffer(slotId: string): Offer | { error: string }` adds conditions: `feeGbp` if new patient and the clinic has a fee; `requiredInfo` if new patient
  - `getOffer(offerId: string): Offer | undefined`
  - `markAccepted(offerId: string): void` is called **only by the orchestrator** after the gate passes
  - `acknowledgeFee(offerId: string): void` is called by the orchestrator when the gate passed with a fee approval
  - `provideInfo(offerId: string, field: string): void`
  - `book(offerId: string, patientName: string): { ok: true; booking: Booking } | { ok: false; reason: 'not_confirmed' | 'fee_not_acknowledged' | 'info_missing' | 'taken' | 'unknown_offer' }`
  - `booked(): Booking | undefined`

- [ ] **Step 1: Failing tests:**
  - `lists in scripted order, not chronological`: clearview list(next week..week+2) → Thu 15:00 first
  - `offer for new patient at riverside carries feeGbp 20 and requiredInfo ['insuranceNumber']`
  - `existing patient offer has no conditions`
  - `book refuses before markAccepted` → `not_confirmed`
  - `book refuses with fee unacknowledged`, then succeeds after `acknowledgeFee` + `provideInfo`
  - `booked slot disappears from list`; `second book of same slot → taken`
  - `unknown offerId → unknown_offer`
  - `offer ids are unique per makeOffer call`

- [ ] **Step 2: Run** `npx vitest run tests/slotBook.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `offerId = \`off-${n}\`` counter.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: scripted slot book with booking preconditions`

---

### Task 7: LLM wrapper, fake LLM, answer interpreter

**Files:**
- Create: `src/server/llm.ts`, `src/server/interpret.ts`, `tests/helpers/fakeLlm.ts`
- Test: `tests/interpret.test.ts`, `tests/llm.test.ts`

**Interfaces:**
- Produces:
  - `type LlmParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming`
  - `type LlmMessage = Anthropic.Beta.Messages.BetaMessage`
  - `type LlmCall = (p: Omit<LlmParams,'model'>, signal?: AbortSignal) => Promise<LlmMessage>`
  - `createLlm(client: Anthropic, opts: { model: string; effort: 'low'|'medium'|'high'; fallbacks: boolean }): LlmCall`
    - Sets `model`, merges `output_config.effort`.
    - When `fallbacks`, adds `betas:["server-side-fallback-2026-07-01"]` and `fallbacks:"default"`.
    - Calls `client.beta.messages.create`.
    - On `NotFoundError`, rethrows `Error("Model '<id>' not found — set CALLER_MODEL/RECEPTIONIST_MODEL/INTERPRET_MODEL in .env")`.
  - `fakeLlm(script: Array<FakeTurn | ((p: LlmParams) => FakeTurn)>): LlmCall & { calls: LlmParams[] }`
    - `FakeTurn = { text?: string; tools?: { name: string; input: object }[]; stop?: 'end_turn'|'tool_use'|'refusal' }`.
    - Builds minimal `BetaMessage` objects; tool ids `tu_<n>`.
    - Throws if the script runs out.
  - `interpretAnswer(answer: string, question: string, llm: LlmCall): Promise<{ decision: 'yes'|'no'|'unclear'; note: string }>`

- [ ] **Step 1: Failing tests** `tests/interpret.test.ts`:
  - `"yes that's fine" → yes without calling llm` (fake with empty script)
  - `"no, try the week after" → no, note includes "week after"` (regex says no; note = original text)
  - `"uh what time was that again?" → unclear` (fake returns `{"decision":"unclear","note":"asked to repeat"}`)
  - `empty string → unclear without llm`
  - `llm returns invalid JSON → unclear` (never yes)

  `tests/llm.test.ts`:
  - `createLlm adds fallbacks and betas when enabled` (stub client capturing params)
  - `omits fallbacks for receptionist`
  - `sets output_config.effort`
  - `maps NotFoundError to env-var hint`

- [ ] **Step 2: Run** `npx vitest run tests/interpret.test.ts tests/llm.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Regex fast path** for the whole-utterance start:
    - yes: `^(yes|yeah|yep|sure|ok(ay)?|fine|that'?s fine|go ahead|book it)\b`
    - no: `^(no|nope|don'?t|not)\b`
  - **Otherwise LLM structured output.** Use `output_config.format` built with the SDK's zod helper for the beta endpoint (see the claude-api skill `typescript/claude-api/tool-use.md` → Structured outputs). Validate the text with the same zod schema; on any failure → `unclear`.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: Claude client wrapper and user-answer interpreter`

---

### Task 8: Receptionist agent

**Files:** Create `src/server/line/receptionist.ts`, add receptionist prompt to `src/server/agents/prompts.ts`; Test `tests/receptionist.test.ts`

**Interfaces:**
- Consumes: `LlmCall`, `fakeLlm` (Task 7), `SlotBook` (Task 6), `Clinic`, `Profile`.
- Produces: `class Receptionist`:
  - `constructor(clinic: Clinic, book: SlotBook, profile: Profile, llm: LlmCall)`
  - `greet(): string` returns the fixed line `"<clinic.name>, <receptionistName> speaking, how can I help?"` (no LLM)
  - `respond(callerText: string, signal?): Promise<{ text: string; offer?: Offer; booking?: Booking; hungUp: boolean }>`

  Internally it runs a tool loop (max 6 iterations) over tools:
  - `list_slots{from,to}`
  - `make_offer{slotId}` → the returned `Offer` is attached to the result
  - `book_slot{offerId}`
  - `lookup_patient{name,dob}` → existing/new based on `profile.existingPatientAt`
  - `end_call{}` → `hungUp: true`

  The final assistant text is the spoken line.

- [ ] **Step 1: Failing tests** (fake LLM):
  - `make_offer tool result is surfaced as structured offer`: script `[tools make_offer{slotId:'bs-1'}] → [text "We have Tuesday at 9"]` → result `.offer.slotId === 'bs-1'`, `.text` matches
  - `book_slot refusal is fed back to the model as tool_result is_error` (inspect `calls[1].messages` last block `is_error: true`)
  - `refusal stop yields polite fallback line and hungUp true`
  - `system prompt includes persona, quirks, and today's date; last system block has cache_control`
  - `loop stops after 6 iterations with a fallback line`

- [ ] **Step 2: Run** `npx vitest run tests/receptionist.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The prompt tells the receptionist to:
  - stay in persona and keep lines to one or two sentences;
  - offer slots **only** via `make_offer`, in the order `list_slots` returns them;
  - mention any fee and required info out loud when offering;
  - follow quirks (ask DOB if `asksDob`);
  - book only via `book_slot` after the caller clearly agrees, and if `book_slot` says `not_confirmed`, ask the caller to confirm the time.

  Conversation history persists across `respond` calls.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: Claude receptionist over scripted slot book`

---

### Task 9: PhoneLine interface + SimulatedLine

**Files:** Create `src/server/line/PhoneLine.ts`, `src/server/line/SimulatedLine.ts`; Test `tests/simulatedLine.test.ts`

**Interfaces:**
- Consumes: `Ivr`, `Receptionist`, `SlotBook`.
- Produces:

```ts
export type LineEvent =
  | { kind: 'ivr'; text: string }
  | { kind: 'hold'; seconds: number }
  | { kind: 'speech'; speaker: 'receptionist'; text: string; offer?: Offer; booking?: Booking }
  | { kind: 'hangup'; reason: 'receptionist' | 'ivr_disconnect' | 'closed' };
export interface PhoneLine {
  dial(signal: AbortSignal): Promise<LineEvent[]>;          // events until the caller must act
  sendDigits(d: string, signal: AbortSignal): Promise<LineEvent[]>;
  say(text: string, signal: AbortSignal): Promise<LineEvent[]>;
  slotBook(): SlotBook;                                      // simulated-only seam used by orchestrator
}
```

  `SimulatedLine(clinic, profile, llm, opts: { holdScale: number; sleep?: (ms, signal) => Promise<void> })`.

  - `dial` returns root IVR prompt events.
  - Reaching a `hold` terminal returns `[hold{seconds}, speech{greet}]` after sleeping `holdSeconds*holdScale*1000`.
  - Reaching `receptionist` returns `[speech{greet}]`.
  - `closed` returns `[ivr text, hangup closed]`.
  - `say` before the receptionist is connected returns `[ivr "Please use your keypad."]`.

- [ ] **Step 1: Failing tests** (fake sleep records ms; fake LLM receptionist):
  - `dial returns root IVR prompt`
  - `pressing 1 at bright-smile yields hold 8s then greeting`; sleep called with `8000` when `holdScale 1`, `0` when `0`
  - `say before connection returns keypad hint`
  - `say after connection delegates to receptionist and passes offer through`
  - `aborted signal rejects hold sleep with AbortError`
  - `billing option ends with hangup closed`

- [ ] **Step 2: Run** `npx vitest run tests/simulatedLine.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The default `sleep` is abortable (`setTimeout` + abort listener).

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: simulated phone line behind PhoneLine interface`

---

### Task 10: Caller tools

**Files:** Create `src/server/agents/callerTools.ts`, add caller prompt to `prompts.ts`; Test `tests/callerTools.test.ts`

**Interfaces:**
- Consumes: `evaluateOffer` (Task 4), `busyBetween` (Task 3), `SlotBook` (Task 6), `Profile`.
- Produces:
  - `callerToolDefs: Anthropic.Beta.Messages.BetaTool[]`. All tools are `strict: true` with `additionalProperties: false`:
    - `press_keys{digits:string}`
    - `say{text:string}`
    - `wait{}`
    - `check_calendar{from:string,to:string}`
    - `get_profile_field{field:string}`
    - `ask_user{question:string, offerId?:string, approvalFor?:('slot'|'fee')[]}`
    - `accept_offer{offerId:string}`
    - `provide_info{offerId:string, field:string, source:'profile'|'user'}`
    - `end_call{outcome:'booked'|'not_booked', summary:string}`
  - `CallState = { request: BookingRequest; profile: Profile; calendar: CalendarEvent[]; approvals: Approval[]; offers: Map<string, Offer>; userAnswers: { field?: string; text: string }[] }`
  - Local executors (no line interaction): `execLocal(name, input, state, book): { content: string; isError?: boolean; offerEvent?: { offer: Offer; gate: GateResult } } | null`. Returns `null` for line/user tools: `press_keys`, `say`, `wait`, `ask_user`, `end_call`.
    - `check_calendar` → JSON of busy events.
    - `get_profile_field` → value from `profile` top-level fields or `profile.fields`; missing → `isError` with "Not on file. Use ask_user to get it from Alex; never guess."
    - `accept_offer` → runs the gate. Pass → `book.markAccepted`, plus `book.acknowledgeFee` if a fee was approved; content "Accepted in system. Now tell the receptionist clearly that you accept." Fail → `isError` with reasons and "Do not accept. Decline politely or use ask_user with offerId and approvalFor."
    - `provide_info` → `source:'profile'` requires the field present; `source:'user'` requires a recorded user answer since the last `ask_user`; then `book.provideInfo`. Otherwise `isError`.

- [ ] **Step 1: Failing tests:**
  - `accept_offer outside window is rejected and slot not marked accepted` (then `book.book()` → `not_confirmed`)
  - `accept_offer after slot approval passes and marks accepted`
  - `accept_offer with fee requires fee approval; after approval acknowledges fee`
  - `accept_offer unknown id → isError unknown_offer`
  - `get_profile_field insuranceNumber → isError "Not on file"`
  - `provide_info source user without a prior answer → isError`
  - `tool defs are strict with additionalProperties false`

- [ ] **Step 2: Run** `npx vitest run tests/callerTools.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The caller system prompt covers:
  - role: phoning on behalf of `<name>`; disclose being an AI assistant first;
  - the `BookingRequest` as hard rules (rendered as JSON) and today's date;
  - use `press_keys` for menus, `wait` on hold;
  - always `accept_offer` before verbally accepting;
  - use `ask_user` (with `offerId` and `approvalFor`) for anything outside the rules, any fee, or any missing info; before `ask_user`, `say` "One moment please, let me check with <first name>.";
  - never invent personal data; be brief and polite; end with `end_call`.

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: caller agent tools with gated acceptance`

---

### Task 11: Call orchestrator

**Files:** Create `src/server/orchestrator.ts`, `src/server/speech/SpeechProvider.ts` (interface only here), `tests/helpers/fakeIo.ts`; Test `tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 6, 7, 9, 10.
- Produces:

```ts
export interface SpeechProvider {
  mode: SpeechMode;
  synthesize(text: string, speaker: Speaker, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string } | null>;
  transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<string>;
}
export interface CallIO {
  emit(msg: ServerMsg): void;
  speak(u: { id: string; speaker: Speaker; text: string; channel: 'call'|'user' }, audio: { audio: Buffer; mime: string } | null): Promise<void>; // resolves after playback ack
  askUser(question: string, timeoutMs: number, attempt: number): Promise<string | null>; // null = timeout
}
export interface CallDeps { line: PhoneLine; llm: LlmCall; interpretLlm: LlmCall; speech: SpeechProvider; io: CallIO; clinic: Clinic; now?: () => number }
export function runCall(state: CallState, deps: CallDeps, signal: AbortSignal): Promise<CallOutcome>;
```

**Loop behaviour:**
- **Start.** `dial`, then render line events. The initial user message to the caller is "Call connected. You hear:" plus the events.
- **Each iteration.** `llm({system, tools: callerToolDefs, messages})`, then handle the response:
  - `refusal` → outcome `aborted` with a polite summary.
  - Text with no tool use → treated as `say(text)`.
  - All `tool_use` blocks are executed; their results are returned in **one** user message.
- **Line tools.** `press_keys`, `say` and `wait` hit the line, and their tool result is what was heard.
- **Hearing.** Each line event is spoken via `io.speak`. In `openai` mode, receptionist/IVR text is synthesized; the audio goes to `io.speak` **and** through `speech.transcribe`, and the transcript is what the caller "hears". In `browser` mode, `audio = null` and the text passes straight through.
- **Agent speech.** Caller utterances are synthesized (openai) and spoken via `io.speak` with speaker `agent`.
- **Disclosure.** If the first `say` after the receptionist connects lacks `/AI assistant/i`, prefix `"Hi, I'm an AI assistant calling on behalf of <name>. "`.
- **`ask_user`.**
  1. Emit `call_status paused` and `needs_user`.
  2. Speak the question on channel `user`, then `io.askUser(question, 15000, attempt)`.
  3. Run `interpretAnswer`.
  4. If the answer is `yes` and `approvalFor` was given, push `{offerId, kinds: approvalFor}` to `state.approvals`.
  5. Record the answer in `state.userAnswers`.
  6. The tool result is `{decision, userSaid}`. An `unclear` answer or a timeout re-asks once (attempt 2); after that the result is `"No answer from user. Decline politely and say you'll call back."`
- **Offers.** Every `speech` event with an `offer` is stored in `state.offers` and emitted as `offer{offer, gate: evaluateOffer(...)}` (preview). Every `accept_offer` result is emitted as `offer`.
- **Ending.** `end_call` → the outcome comes from `line.slotBook().booked()`: status `booked` only if the slot book has a booking (the agent's claim is never trusted). A mismatch is logged in the summary as `"(agent reported booked but clinic has no booking)"`. `hangup` events also end the call.
- **Limits.** 40 iterations or 300 s → say `"I'm sorry, I'll have to call back later. Goodbye."`, outcome `not_booked`.
- **Speech failure.** If `synthesize` or `transcribe` throws, log it, use `audio=null` / the raw text for that utterance, and continue.
- **Events and transcript.** Emit `call_status` transitions, `ivr_key`, `hold start/end`, and `call_ended` (with `ics` when booked, via `toIcs`). The transcript accumulates every spoken line plus `meta` for keys and holds.

- [ ] **Step 1: Failing tests** (fake LLM + `SimulatedLine` with `holdScale 0` + fake receptionist LLM + `fakeIo` recording emits/speaks with scripted `askUser` answers + fake speech):
  - `prefixes AI disclosure when agent's first say lacks it`
  - `rejects out-of-window accept_offer without approval and does not book` (receptionist offers Thu 15:00; agent calls `accept_offer` → isError; then `end_call not_booked`) → outcome `not_booked`, `book.booked()` undefined
  - `ask_user yes records slot approval and booking succeeds` → outcome `booked`, `start === '2026-11-19T15:00'`
  - `ask_user unclear twice → no approval, tool result tells agent to decline` (Review Focus 1)
  - `ask_user timeout (null) counts as no approval`
  - `agent claims booked but slot book empty → outcome not_booked with mismatch note` (Review Focus 4)
  - `text-only response is spoken as say`
  - `stops at 40 iterations with goodbye line`
  - `openai mode: receptionist text goes through transcribe before reaching caller` (fake transcribe returns modified text, assert the caller's next request contains it)
  - `synthesize throwing degrades to text and call completes` (Review Focus 2)
  - `refusal from caller llm → aborted outcome with summary`
  - `all tool_results returned in a single user message`
  - `aborting the signal rejects with AbortError and makes no further llm calls`

- [ ] **Step 2: Run** `npx vitest run tests/orchestrator.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `runCall`** per the behaviour above. Keep helpers small: `renderEvents`, `hear`, `agentSay`, `handleAskUser`, `finish`.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: all PASS.

- [ ] **Step 5: Commit (author).** `feat: call orchestrator with check-ins, limits and speech bridging`

---

### Task 12: Intake agent

**Files:** Create `src/server/agents/intake.ts`; Test `tests/intake.test.ts`

**Interfaces:**
- Consumes: `LlmCall`, `Clinic[]`, `Profile`, `weekRange`.
- Produces: `class Intake`:
  - `constructor(clinics: Clinic[], profile: Profile, today: string, llm: LlmCall)`
  - `hear(text: string): Promise<{ kind: 'question'; question: string } | { kind: 'ready'; request: BookingRequest; summary: string }>`
  - Conversation history is kept so answers to clarifying questions merge.

  Output schema (structured output):
  - `clinicId` (enum of clinic ids, or `null`), `service` (string or `null`)
  - `dateFrom`, `dateTo`, `timeWindow`, `excludedWeekdays`, `notes`
  - `clarifyingQuestion` (string or `null`), `summary` (string)

  Code applies defaults after parsing:
  - `patientName = profile.name`
  - missing dates → next week (`weekRange(1)`)
  - "mornings" → `08:00–12:00`, "afternoons" → `12:00–17:00`, none → `08:00–18:00` (the prompt instructs these mappings; code applies the default only when `timeWindow` is null)
  - missing `service` → `clinic.service`

  `clinicId` null → `question`. The code-side validation also rejects `dateFrom` > `dateTo` and past dates (→ question).

- [ ] **Step 1: Failing tests** (fake LLM returning JSON):
  - `full request becomes ready with excludedWeekdays [3] and window 08:00–12:00`
  - `missing clinic yields clarifying question`; then `hear("Bright Smile")` → ready (assert history has 2 user turns)
  - `unknown clinic id from model is treated as missing`
  - `past date range yields question`
  - `invalid JSON yields "Sorry, could you say that again?" question`

- [ ] **Step 2: Run** `npx vitest run tests/intake.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Commit (author).** `feat: intake agent turns spoken request into booking rules`

---

### Task 13: CLI scenario runner + live smoke test

**Files:** Create `src/cli/scenario.ts`

**Interfaces:**
- Consumes: Tasks 2, 7, 9, 11, 12, `loadConfig`.
- Produces: `npm run scenario -- <clinicId> [--runs N] [--answer "yes"|"no"|"silent"] [--fast]`.
  - Speech mode is forced to text: a `SpeechProvider` that returns `null`/identity.
  - `CallIO` prints colored transcript lines and answers `askUser` with `--answer` (default `yes`; `silent` → `null`).
  - Runs intake with the clinic's `demoRequest`, auto-confirms, then `runCall`.
  - `--fast` sets `holdScale 0`.
  - Prints the outcome per run and a final `passed X/N`.
  - Expected outcome per scenario: bright-smile `booked` at Thu 10:30 with no `needs_user`; clearview with `--answer yes` `booked` at Thu 15:00; riverside `booked` only after `needs_user` for both the fee and the insurance number (CLI answers "yes, and my insurance number is AB123456").

- [ ] **Step 1: Implement the runner.**

- [ ] **Step 2: Live run** (needs a real key; costs a few cents): `npm run scenario -- bright-smile --runs 5 --fast`. Expected: `passed 5/5`.

- [ ] **Step 3: Live run** `npm run scenario -- clearview --runs 5 --fast --answer yes` and `npm run scenario -- riverside --runs 5 --fast`. Expected: `passed 5/5` each. If a run fails, tune prompts in `prompts.ts` (not the gate) and re-run all three. Paste final transcripts for the author to read.

- [ ] **Step 4: Live run** `npm run scenario -- clearview --runs 2 --fast --answer silent`. Expected: `not_booked`, polite call-back line.

- [ ] **Step 5: Commit (author).** `feat: CLI scenario runner; tune prompts to 5/5`

---

### Task 14: Speech providers, session, server

**Files:**
- Create: `src/server/speech/openai.ts`, `src/server/session.ts`, `src/server/index.ts`
- Modify: `src/server/speech/SpeechProvider.ts` (add `createSpeech(config)` factory + `BrowserSpeech`)
- Test: `tests/session.test.ts`, `tests/speechFactory.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `createSpeech(config: Config): SpeechProvider`. `BrowserSpeech`: `synthesize → null`; `transcribe` throws `"browser mode: client sends text"`.
  - `OpenAISpeech(apiKey, opts?: { sttModel?: string; ttsModel?: string })`:
    - defaults `gpt-4o-mini-transcribe` / `gpt-4o-mini-tts`, env-overridable via `OPENAI_STT_MODEL` / `OPENAI_TTS_MODEL`
    - voices: agent `alloy`, receptionist `coral`, ivr `onyx`, assistant `sage`
    - mp3 output
    - `transcribe` uses `openai.audio.transcriptions.create` with `toFile(buffer, 'audio.webm')`
  - `class Session { constructor(send: (m: ServerMsg) => void, deps: SessionDeps); handle(msg: ClientMsg): Promise<void>; dispose(): void }`.
    - States: `idle → intake → confirming → calling → done`.
    - `hello` on construct.
    - **Intake:** `user_utterance` in `idle/intake` (audio → `speech.transcribe` in openai mode) goes to `Intake.hear`. A question is spoken as `assistant` on channel `user`. `ready` → `request_understood` + spoken summary "…Shall I call them now?" → `confirming`.
    - **Confirming:** `confirm{yes}` or a spoken yes/no (via `interpretAnswer`) → `calling`, or back to `idle` (spoken "Okay, cancelled.").
    - `choose_scenario` = `user_utterance{text: clinic.demoRequest}`.
    - **Calling:** builds a `SimulatedLine` + `CallState` and runs `runCall` with an `AbortController`. `CallIO.speak` sends `utterance` and resolves on `played{id}`, or immediately when listen-in is off, or after a timeout of `max(3000, words*450) + 2000` ms. `CallIO.askUser` resolves on the next `user_utterance` in state `calling`.
    - **Done:** on finish, `appendBooking` if booked → `done`. `reset` → `idle`.
    - Messages invalid for the current state → `error{message}` without crashing; a second request while calling is rejected.
    - `dispose` aborts the controller and clears timers.
  - `index.ts`: Fastify on `config.port`, `@fastify/websocket` route `/ws` (one `Session` per socket, JSON messages validated with zod, `dispose` on close), `@fastify/static` serving `dist/` in `start`. Fails fast with the config error message.

- [ ] **Step 1: Failing tests** `tests/session.test.ts` (fake LLMs, browser speech, `holdScale 0`, auto-ack `played`):
  - `sends hello with speechMode and three scenarios`
  - `choose_scenario → request_understood → confirm yes → call_ended booked` (bright-smile scripted fakes)
  - `confirm no returns to idle`
  - `user_utterance while calling routes to pending askUser`
  - `second choose_scenario during call → error, call continues`
  - `dispose mid-call aborts: no further llm calls, no unhandled rejection` (Review Focus 3; use `process.on('unhandledRejection')` spy)
  - `listen_in off resolves speak immediately`

  `tests/speechFactory.test.ts`:
  - `browser mode when no openai key`
  - `openai voices are distinct per speaker`

- [ ] **Step 2: Run** `npx vitest run tests/session.test.ts tests/speechFactory.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `SpeechProvider.ts` factory, `openai.ts`, `session.ts`, `index.ts`.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Manual check.** `npm start` with only `ANTHROPIC_API_KEY`. Log shows `speech: browser`, listening on 3001.

- [ ] **Step 6: Commit (author).** `feat: websocket session, OpenAI speech provider and server`

---

### Task 15: Web UI (browser speech mode)

**Files:**
- Create: `src/web/index.html`, `main.tsx`, `App.tsx`, `ws.ts`, `audio.ts`, `tones.ts`, `capabilities.ts`, `browserSpeech.ts`, `components/{RequestPanel,CallPanel,CheckIn,ResultCard}.tsx`, `styles.css`
- Test: `tests/web/capabilities.test.ts`, `tests/web/tones.test.ts`

**Interfaces:**
- Consumes: `protocol.ts`.
- Produces:
  - `detectCapabilities(win: { navigator?: any; SpeechRecognition?: any; webkitSpeechRecognition?: any; speechSynthesis?: any; MediaRecorder?: any }): { recognition: boolean; synthesis: boolean; recorder: boolean; mic: boolean }`
  - `dtmfFreqs(digit: string): [number, number]` (exact DTMF pairs, e.g. `'1' → [697, 1209]`)
  - `useSocket(): { state; send(m: ClientMsg) }`. `state` is a reducer over `ServerMsg`: phase, transcript, request, pendingQuestion, outcome, speechMode.
  - `audio.ts` `Player`:
    - plays `utterance`s sequentially: openai audio via `<audio>` blob, or `speechSynthesis` with a distinct voice per speaker in browser mode;
    - sends `played{id}`;
    - plays DTMF on `ivr_key` and synthesized hold music (simple looping arpeggio via WebAudio) between `hold start/end`;
    - honors listen-in (call channel muted → ack immediately; user channel always plays).

**UI:** follows the spec §5 sketch.
- Header shows the speech-mode badge.
- RequestPanel: hold-to-talk button and spacebar push-to-talk, scenario dropdown, understood-request summary, Confirm/Decline buttons.
- CallPanel: live transcript with speaker icons, timer, listen-in toggle, phase indicator ("thinking…" while waiting on the agent).
- CheckIn:
  - On `needs_user`, a chime plays and the question shows with a countdown.
  - After the question's `played`, listening starts automatically (browser mode: `SpeechRecognition`, `interimResults` on, single result) and the transcript is sent as `user_utterance`.
  - Yes/No buttons are a fallback.
- ResultCard: booking details, `.ics` download (Blob from `call_ended.ics`), summary, collapsible transcript, "New request" (`reset`).
- When `detectCapabilities` reports no recognition or no mic: show a notice banner and a text input for requests and answers (Review Focus 5).

- [ ] **Step 1: Failing tests:**
  - `detectCapabilities: Firefox-like (no SpeechRecognition) → recognition false`
  - `webkit prefix counts as recognition`
  - `dtmfFreqs('1') = [697,1209], ('#') = [941,1477]`
  - `dtmfFreqs('x') throws`

- [ ] **Step 2: Run** `npx vitest run tests/web`. Expected: FAIL.

- [ ] **Step 3: Implement** the modules and components above. Keep the visual style clean and calm (design is the builder's call per spec §11; use the frontend-design skill for the visual pass).

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Manual verification in Chrome** with `npm run dev` and only the Anthropic key:
  - (a) Scenario "Bright Smile" → menu tone, hold music, booked Thu 10:30, `.ics` downloads.
  - (b) Speak "Get me an eye test at Clearview next week, mornings" → summary → say "yes" → the agent asks about Thu 3pm aloud → say "yes" → booked.
  - (c) Firefox shows the notice and text box, and the flow completes by typing.
  - Record any issue and fix before committing.

- [ ] **Step 6: Commit (author).** `feat: web UI with browser speech fallback`

---

### Task 16: OpenAI voice mode in the UI

**Files:** Create `src/web/recorder.ts`; Modify `RequestPanel.tsx`, `CheckIn.tsx`, `audio.ts`; Test `tests/web/vad.test.ts`

**Interfaces:**
- Produces:
  - `class Recorder { start(opts: { autoStop: boolean; maxMs: number }): Promise<Blob> }`. Uses `MediaRecorder` (`audio/webm;codecs=opus`). The blob goes base64 into `user_utterance{audioB64, mime}`.
  - `vadShouldStop(samples: { t: number; rms: number }[], opts = { speechRms: 0.02, silenceMs: 1200 }): boolean`. A pure function: true once speech has occurred and RMS stays below the threshold for `silenceMs`.
  - In openai mode: push-to-talk uses `Recorder` with `autoStop:false`; the check-in uses `autoStop:true, maxMs: 15000`, fed by an `AnalyserNode` RMS sampler every 50 ms into `vadShouldStop`.

- [ ] **Step 1: Failing tests:**
  - `no speech yet → false even after long silence`
  - `speech then 1200ms silence → true`
  - `speech then 800ms silence → false`

- [ ] **Step 2: Run** `npx vitest run tests/web/vad.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Manual verification** with both keys, in Chrome and one other browser (Edge or Firefox): repeat Task 15 Step 5 (a) and (b). The header badge shows OpenAI, voices differ per speaker, and the check-in stops recording on its own after you stop speaking. Note per-turn latency; if it is clearly above about 4 s, report it to the author before committing.

- [ ] **Step 6: Commit (author).** `feat: OpenAI voice mode with auto-stop check-in recording`

---

### Task 17: Docs

**Files:** Create `README.md`, `ai.md`, `WRITEUP.md`

- [ ] **Step 1: README.md** covers:
  - one-paragraph pitch
  - a GIF/screenshot placeholder
  - prerequisites (Node ≥ 20, Chrome/Edge for one-key mode)
  - setup (`npm install`, `cp .env.example .env`, keys), run (`npm run dev` → `http://localhost:5173`)
  - speech modes table
  - the three scenarios and what each demonstrates
  - CLI (`npm run scenario`), tests (`npm test`)
  - architecture diagram (from spec §6)
  - guardrails ("enforced in code" paragraph)
  - known limitations (simulated line, half-duplex, demo data)
  - project structure

- [ ] **Step 2: ai.md:**
  - Design-time tools: Claude Code was used for brainstorming, design spec, implementation plan, pair-implementation and review. Say which parts the author wrote, reviewed or changed. **The author fills in their own contribution honestly.**
  - Runtime: Claude API (models and why: Sonnet 5.5 caller, Haiku 5.5 receptionist/interpreter); OpenAI STT/TTS; browser Web Speech.

- [ ] **Step 3: WRITEUP.md** (≤ 1 page):
  - what was built; who it's for (busy people; phone anxiety, hearing/speech, language barriers)
  - the problem
  - why voice: the three moments from spec §1
  - how it keeps the user in control (code-gated guardrails, disclosure)
  - next steps: real telephony via `PhoneLine`/Twilio, barge-in and streaming TTS, real calendars, clinic-side verification of AI callers (a Hiya angle), multilingual calls

- [ ] **Step 4: Verify** by following README setup from a fresh clone in a new folder: `npm install && npm test && npm run dev`. Expected: tests pass, app loads.

- [ ] **Step 5: Commit (author).** `docs: README, ai.md and write-up`

---

### Task 18: Polish (cut first if time is short)

**Files:** Create `data/clinics/sunny-eyes.json`; Modify UI styles as needed; Test `tests/data.test.ts` (extend)

- [ ] **Step 1: Failing test.** `sunny-eyes IVR has a closed branch and loads`.
- [ ] **Step 2: Add the 4th scenario "Sunny Eyes Opticians".** The IVR announces "We're currently closed. Our opening hours are 9 to 5." on the root's option `1`, then hangs up. Expected outcome: `not_booked` with summary suggesting a call-back time. Verify via `npm run scenario -- sunny-eyes --runs 3 --fast`. Expected: `passed 3/3` (expected outcome `not_booked`).
- [ ] **Step 3: UI finish pass.** Empty states, error banner for `error` messages, keyboard accessibility (tab order, `aria-live="polite"` on transcript), reduced-motion.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit (author).** `feat: closed-clinic scenario and UI polish`
