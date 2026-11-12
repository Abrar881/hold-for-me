# Hold For Me — Design

*Working name. Hiya Voice AI Challenge, Productivity track. 2026-11-12.*

## 1. Intent and why

A voice agent that phones a dentist, optician or similar clinic **on the user's behalf** and books an appointment. The user speaks the request in a few seconds; the agent navigates the phone menu, waits on hold, talks to the receptionist, checks back with the user by voice only when needed, and returns a confirmed booking.

Built as a submission for a Hiya internship challenge. Hiya's business is phone calls (caller ID, spam/scam protection, AI call screening, deepfake voice detection), so a product that lives inside a real phone call shows domain understanding. Judges weigh **choice of problem and why voice** as heavily as code.

**Who it's for**
- Primary: busy people for whom a 15-minute call during clinic opening hours (which overlap their work hours) is real friction.
- Secondary (write-up angle): people with phone anxiety, hearing or speech difficulties, or limited English, for whom the call itself is a barrier.

**Why voice is the right interface (the key moments)**
1. **The call itself.** Clinic booking still happens by phone; receptionists and phone menus only speak voice. There is no keyboard alternative to the counterpart.
2. **The request.** "Book me a check-up at Bright Smile next week, mornings, not Wednesday" takes 5 seconds to say while walking or working; a form takes longer.
3. **The mid-call check-in.** When the receptionist offers something outside the user's rules, the decision is needed *within seconds* while the line is live. A spoken question with a spoken answer is the only interaction fast enough and hands-free.

## 2. Goals, non-goals, anti-goals

**Goals**
- End-to-end working demo: spoken request → simulated call (phone menu, hold, receptionist conversation) → mid-call voice check-in → confirmed booking with summary and transcript.
- Runs locally for judges with **one API key** (Anthropic); sounds natural with a second (OpenAI).
- At least 3 scripted clinic scenarios that exercise different agent behaviour.
- Clean, readable code the author (an intern candidate) can explain line by line in an interview.
- Deliverables: README.md (setup/run), ai.md (AI tools used), WRITEUP.md (1 page), optional demo video.

**Non-goals (v1)**
- Real phone calls (Twilio etc.). Architecture must make this a clean "next step", but it is not built.
- Barge-in / interrupting mid-sentence. Turns are half-duplex.
- Real calendar integration (Google/Outlook). A local JSON calendar stands in.
- Multi-user, auth, persistence beyond local files, deployment.
- Mobile app.

**Anti-goals (failure even if it technically works)**
- The agent **pretends to be human**. It must disclose it is an AI assistant calling on behalf of the user at the start of every call.
- The agent **agrees to anything the user didn't authorise**: a slot outside their rules, a fee, sharing personal data not in the profile. These require a check-in.
- A demo that breaks on the judges' machine. Reliability beats flash.
- The user has to click or watch the screen during the call. The point is hands-free.

## 3. Constraints

- Language: TypeScript everywhere (Node server + browser client). Node ≥ 20 (author has Node 26).
- Must run with `npm install` + `.env` with `ANTHROPIC_API_KEY` + `npm run dev`. `OPENAI_API_KEY` optional.
- Fallback mode (no OpenAI key) depends on the browser Web Speech API, which is reliable in Chrome/Edge only. README states this.
- Secrets only in `.env` (git-ignored); `.env.example` committed.
- The author commits and pushes; the builder never runs git commits.
- Model IDs: caller agent `claude-sonnet-5-5`, receptionist `claude-haiku-5-5` (faster, cheaper; persona work is easier). Both configurable via env.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| 1 | Browser-native speech (Web Speech API) + Claude for both agents | One key, cheapest, simplest. Robotic voices, Chrome-only, agents exchange text with voices layered on. |
| 2 | Realtime speech-to-speech (OpenAI Realtime), audio bridged between two live sessions | Most natural, true interruptions. Costliest, hardest to debug, non-deterministic demos, provider lock-in. |
| 3 | Server pipeline: Claude brains + OpenAI STT/TTS; receptionist audio is transcribed before the caller agent "hears" it | Natural voices, any browser, mirrors a real phone line, easy to swap in telephony. More moving parts, two keys. |

**Chosen: 3, with 1 as automatic fallback.** If `OPENAI_API_KEY` is absent, speech falls back to the browser. Rationale: quality and realism of 3, judge-runnability of 1. The fallback is itself a design point for the write-up ("runs with one key, sounds great with two").

Real vs simulated call: **simulated** chosen (judges can run it; demo is deterministic; tricky cases are scriptable). Real telephony is listed as the next step.

## 5. The experience

Single web page. Three phases.

```
┌──────────────────────────────────────────────┐
│ Hold For Me                     [voice: OpenAI ✓]│
│                                                │
│  (1) REQUEST                                   │
│  [ 🎙 Hold to talk ]  or  [scenario ▾]          │
│  "Book a check-up at Bright Smile next week,   │
│   mornings, not Wednesday."                    │
│  → Understood: Bright Smile Dental · check-up  │
│    · 16–20 Nov · before 12:00 · not Wed        │
│                                                │
│  (2) LIVE CALL  ● 02:14   [Listen in 🔊/🔇]     │
│  📞 Menu: "Press 1 for appointments" → 1        │
│  🎵 On hold (0:20)                              │
│  🏥 Receptionist: "Bright Smile, Sarah speaking"│
│  🤖 Agent: "Hi, I'm an AI assistant calling for │
│     Alex Khan to book a check-up…"              │
│  ⏸ AGENT NEEDS YOU: "They offer Thu 3pm. OK?"   │
│                                                │
│  (3) RESULT                                    │
│  ✅ Thu 19 Nov, 10:30 · Bright Smile Dental     │
│  [Add to calendar (.ics)]  [Transcript]  Summary│
└──────────────────────────────────────────────┘
```

**Phase 1: Request.** User holds the talk button (or spacebar) and speaks. The caller agent extracts a structured `BookingRequest` and asks spoken clarifying questions only for missing required fields (clinic, service). It reads the understood request back in one sentence; user says "yes" or corrects. A scenario picker lets judges start a scripted scenario with a pre-filled request, for reliability.

**Phase 2: Live call.** The user can listen in (call audio plays) or mute and walk away. The screen shows a live transcript with speaker icons, phone-menu key presses, and hold timer.

**Mid-call check-in.** When the caller agent needs a decision:
1. Agent tells receptionist "One moment please, let me check with Alex." Receptionist is paused.
2. The browser plays a distinct chime, speaks the question to the user, and **automatically starts listening** (no click), with a visible countdown (~15 s).
3. The user's spoken answer goes to the agent, which resumes the call.
4. On timeout: agent asks the receptionist to hold the slot briefly if possible, re-prompts the user once, then politely declines and says it will call back.

**Phase 3: Result.** Confirmation card, appointment added to the local calendar file, `.ics` download, a 2–3 sentence summary, and full transcript. Failures (no suitable slot, clinic closed) also end with a clear summary and suggested next step.

## 6. Architecture

```
Browser (React + Vite)                     Node server (TypeScript)
┌──────────────────────┐   WebSocket   ┌──────────────────────────────┐
│ Mic capture / PTT    │◄────────────►│ Session                       │
│ Audio playback       │  events +     │  ├─ IntakeAgent (Claude)       │
│ Web Speech fallback  │  audio chunks │  ├─ CallOrchestrator           │
│ Transcript / UI      │               │  │   ├─ CallerAgent (Claude)    │
└──────────────────────┘               │  │   └─ PhoneLine (interface)   │
                                       │  │        └─ SimulatedLine      │
                                       │  │            ├─ IVR (state machine)
                                       │  │            ├─ Hold (timer+audio)
                                       │  │            └─ ReceptionistAgent (Claude)
                                       │  └─ SpeechProvider (interface) │
                                       │      ├─ OpenAISpeech           │
                                       │      └─ BrowserSpeech (proxy)  │
                                       └──────────────────────────────┘
```

**Key modules**

- **`PhoneLine` interface**: the seam for real telephony later. Methods roughly: `dial(clinicId)`, `sendDigits(digits)`, `say(text)`, events `onAudio/onText`, `onHangup`. v1 ships `SimulatedLine` only. A `TwilioLine` would implement the same interface.
- **`SimulatedLine`**: composes:
  - **IVR**: deterministic state machine loaded from clinic JSON (prompts, digit → next node, "hold" and "receptionist" terminals). Not LLM-driven, because real phone menus aren't, and it keeps demos deterministic. DTMF tones are played as short audio for realism.
  - **Hold**: configurable duration per clinic, plays hold-music clip and occasional "your call is important" message.
  - **ReceptionistAgent**: Claude with clinic persona and tools over that clinic's slot book: `list_slots(range)`, `book_slot(slotId, patient)`, `lookup_patient(name, dob)`. Behaviour quirks come from clinic JSON (e.g., "always asks DOB", "pushes afternoon slots first", "charges a £20 new-patient fee").
- **`CallerAgent`**: Claude with tools:
  - `press_keys(digits)`, `say(text)`, `wait()` (stay silent on hold)
  - `check_calendar(range)` → user's busy times from `calendar.json`
  - `get_profile_field(field)` → from `profile.json`; fields not present require `ask_user`
  - `ask_user(question)` → triggers the check-in flow; returns user's transcribed answer or `timeout`
  - `confirm_booking(details)`, `end_call(outcome, summary)`
  System prompt encodes: AI disclosure first, the user's `BookingRequest` as hard rules, never accept outside-rules offers / fees / data sharing without `ask_user`, be concise and polite.
- **`CallOrchestrator`**: owns turn-taking (half-duplex). Loop: line produces utterance → (server mode) TTS audio streamed to browser for listening-in **and** STT transcribes that audio → transcript given to caller agent → agent's tool calls executed → agent speech goes through TTS → transcript to receptionist → repeat. Emits UI events (`transcript`, `ivr_key`, `hold_start/end`, `needs_user`, `call_ended`). Hard limits: max turns, max call duration, to prevent runaway loops and cost.
- **`SpeechProvider` interface**: `transcribe(audio) → text`, `synthesize(text, voice) → audio`.
  - `OpenAISpeech`: OpenAI STT + TTS, distinct voices for agent, receptionist, IVR.
  - `BrowserSpeech`: server sends text + voice hint to the browser; browser uses `speechSynthesis` for output and `SpeechRecognition` for the user's mic. In this mode the receptionist→caller path skips STT (text passed directly) and the README says so.
  - Selected at startup by presence of `OPENAI_API_KEY`; shown in the UI header.
- **`IntakeAgent`**: turns the user's spoken request into `BookingRequest { clinicId, service, patientName, dateRange, timeWindow, excludedDays, notes }` via Claude structured output, plus clarifying questions.

**Guardrails are enforced in code, not only in prompts** *(builder's call)*
- Offers are **structured events**. The receptionist's speech is paired with a tool call `make_offer({ slotId, start, end, conditions: { fee?, requiredInfo?[] } })`. The orchestrator hands the offer to the caller agent alongside the transcript.
- The caller agent accepts only via `accept_offer(offerId)`. A **code gate** checks the offer against the `BookingRequest` rules (date range, time window, excluded days), calendar clashes, and any fee or data condition. Anything outside the rules is rejected with "needs user approval" unless a matching `ask_user` approval is recorded for that offer.
- `book_slot` on the receptionist side runs only after the gate has passed. The **slot book is the source of truth** for the result card; the caller's `confirm_booking` must match it or the run is flagged.
- Personal data: `get_profile_field` returns only fields present in `profile.json`; a missing field returns "ask the user", and the agent cannot fill it in itself.
- This makes the fake-LLM tests meaningful: "an out-of-window `accept_offer` without approval is rejected" is a code assertion.

**Determinism: scripted beats, free phrasing** *(builder's call)*
- The slot book, offer order and quirk beats are **deterministic in code**. `list_slots` returns slots in the clinic's scripted order. Quirks are enforced by tools: for example, `book_slot` refuses until the fee has been stated and acknowledged in that clinic.
- The LLM only phrases the receptionist's lines. Claude 5.5 models reject non-default `temperature`, so consistency comes from code-enforced beats and short, specific prompts, not from sampling settings.
- Acceptance bar: each scenario reaches its expected outcome **5/5 runs** on the live smoke test.

**Latency** *(builder's call)*
- Whole-utterance, half-duplex TTS (no sentence-level streaming) in v1.
- Target: **about 4 s or less per turn**. Transcript text appears in the UI as soon as it exists, with a "speaking / thinking" indicator so pauses read as natural.
- Use prompt caching on the system prompts. Streaming TTS is listed as a next step.

**Model fallback:** model IDs come from env (`CALLER_MODEL`, `RECEPTIONIST_MODEL`). If a model call fails with model-not-found, the server logs a clear error naming the env var to set. The caller agent (`claude-sonnet-5-5`) has server-side refusal fallback enabled (`fallbacks: "default"`). A `refusal` stop on either agent ends the call gracefully with a summary.

**Data files (`data/`)**
- `profile.json`: user name, DOB, phone, existing-patient flags per clinic. Deliberately omits something (e.g., insurance number) so a scenario forces `ask_user`.
- `calendar.json`: user's existing events (for clash checks); bookings are appended.
- `clinics/*.json`: name, persona, IVR tree, hold duration, slot book, quirks.

## 7. Scenarios (minimum 3)

1. **Bright Smile Dental (happy path + clash).** IVR "press 1 for appointments", short hold, receptionist asks DOB (agent answers from profile), first offer clashes with a calendar event, so the agent declines and gets a fitting morning slot. No check-in needed; shows autonomy.
2. **Clearview Opticians (check-in).** Next week fully booked except Thursday 3 pm (outside "mornings"). Agent puts receptionist on hold, asks user by voice, user says "yes, that's fine" (or "no, try the week after"), call completes accordingly.
3. **Riverside Dental (guardrails).** New-patient registration: receptionist mentions a £20 registration fee and asks for an insurance number not in the profile. Agent must `ask_user` for both, not invent or agree on its own.

Optional 4th: clinic closed / wrong IVR option, so the agent recovers or ends gracefully with a summary.

## 8. Testing

- **Unit:** IVR state machine, calendar clash logic, request validation, orchestrator turn limits, tool executors. Pure functions, no network.
- **Agent logic with fakes:** orchestrator tests using a scripted fake LLM and fake speech provider, asserting e.g. "ask_user is called before accepting an out-of-window slot", "AI disclosure is the first utterance".
- **Live scenario smoke test:** a script (`npm run scenario -- bright-smile`) that runs a full call in text-only mode against real Claude and prints the transcript + outcome. Used manually before demo, not in CI.
- **Manual:** full run in Chrome in both speech modes.

## 9. Deliverables

- `README.md`: what it is, prerequisites, setup (`.env`), run, speech modes, scenarios, project structure, known limitations.
- `ai.md`: AI tools used (Claude Code for design/planning/implementation assistance; Claude API and OpenAI API at runtime) and how.
- `WRITEUP.md`: 1 page: what, who, problem, why voice, what's next (real telephony via `PhoneLine`, barge-in, real calendars, voice-cloned/consented personal voice, Hiya-style call verification so clinics trust AI callers).
- Demo video (author records): run scenarios 1 and 2.

## 10. Build order *(builder's call)*

1. Text-only core: data files, IVR, simulated line, both agents, guardrail gate, orchestrator, CLI scenario runner, tests.
2. Web UI with browser speech (fallback mode). The app is fully usable with one key at this point.
3. OpenAI speech mode (used for the demo video).
4. Docs: README, ai.md, WRITEUP.md.
5. Polish: 4th scenario, UI finish, audio assets.

If time runs short, cut from the bottom up.

## 11. Left to the builder

- Exact prompts, UI styling, component breakdown in React.
- Server framework (Fastify or Express) and WebSocket library.
- Which OpenAI STT/TTS models and voices (use current ones; low latency preferred).
- Audio formats/chunking, hold-music and DTMF assets (generate or use royalty-free).
- Exact slot books and personas within the scenarios above.
- Test framework (Vitest suggested).
