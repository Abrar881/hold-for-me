# Hold For Me

A voice agent that phones a dental or optician clinic on your behalf: it navigates the phone menu, waits on hold, talks to the receptionist, and books an appointment. It checks back with you by voice — in real time — only when a decision requires your input. When the call ends, you have a confirmed slot, a calendar entry, and a full transcript.

Built for the Hiya Voice AI Challenge, Productivity track.

---

![screenshot — will be replaced with a GIF before submission](docs/screenshot-placeholder.png)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node ≥ 20 | Tested on Node 26 |
| `ANTHROPIC_API_KEY` | Required; powers all agent reasoning |
| `OPENAI_API_KEY` | Optional; enables natural speech (see Speech modes) |
| Chrome or Edge | Required for browser speech mode (one-key) |

## Setup

```bash
git clone <repo-url>
cd hold-for-me

npm install

cp .env.example .env
# edit .env — at minimum, add your ANTHROPIC_API_KEY
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Claude API key |
| `OPENAI_API_KEY` | — | Optional. Activates OpenAI speech mode |
| `CALLER_MODEL` | `claude-sonnet-5-5` | Model for the caller / intake agents |
| `RECEPTIONIST_MODEL` | `claude-haiku-5-5` | Model for the simulated receptionist |
| `INTERPRET_MODEL` | `claude-haiku-5-5` | Model for answer interpretation |
| `CALLER_EFFORT` | `low` | Thinking budget: `low` / `medium` / `high` |
| `RECEPTIONIST_EFFORT` | `low` | Thinking budget for the receptionist |
| `TODAY` | today's date | Override date, `YYYY-MM-DD` (useful for tests) |
| `HOLD_SCALE` | `1` | Multiply hold durations — set `0.1` for fast demos |
| `PORT` | `3001` | Server port |

## Run

```bash
npm run dev
```

Opens:
- **Browser UI** → http://localhost:5173
- **API server** → http://localhost:3001
- WebSocket at `/ws` is proxied by Vite to the server automatically.

## Speech modes

| Keys provided | Mode | Voices | Browser required |
|---|---|---|---|
| `ANTHROPIC_API_KEY` only | **Browser** | Browser `speechSynthesis` / `SpeechRecognition` | Chrome or Edge |
| `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` | **OpenAI** | Distinct voices for agent, receptionist and IVR via `gpt-4o-mini-tts` / `gpt-4o-mini-transcribe` | Any modern browser |

The active mode is shown in the top-right corner of the UI. In browser mode, receptionist audio is not transcribed by STT — text is passed directly between agents, and the README header says so.

## Scenarios

Run any scenario from the browser UI (scenario picker) or from the CLI.

| Clinic ID | Clinic name | What it demonstrates |
|---|---|---|
| `bright-smile` | Bright Smile Dental | Happy path + calendar clash: agent answers a DOB check from profile data, skips a clashing slot, and books a matching morning appointment without needing the user's input |
| `clearview` | Clearview Opticians | Mid-call check-in: the only next-week slot is outside the requested window (Thursday 3 pm vs "mornings"), so the agent pauses the call and asks the user by voice |
| `riverside` | Riverside Dental | Guardrails under pressure: new-patient registration triggers a £20 fee and a request for an insurance number not in the profile — the agent must ask the user for both before proceeding |
| `sunny-eyes` | Sunny Eyes Opticians | Graceful failure: the IVR routes to a "currently closed" terminal, the agent ends the call and returns a clear summary with a suggested next step |

### CLI scenario runner

```bash
# Run bright-smile (interactive — the CLI handles the mid-call check-in turn)
npm run scenario -- bright-smile

# Non-interactive: auto-answer the check-in with "yes"
npm run scenario -- clearview --answer yes

# Non-interactive: auto-answer with "no"
npm run scenario -- clearview --answer no

# Non-interactive: simulate a timeout (user does not respond)
npm run scenario -- clearview --answer silent

# Run the scenario five times and report outcomes
npm run scenario -- bright-smile --runs 5

# Skip hold delays (useful for quick checks)
npm run scenario -- riverside --fast
```

The CLI runner operates in text-only mode (no audio). It prints a live transcript and an outcome card. Use `--fast` together with `--runs N` for rapid smoke-testing.

## Tests

```bash
npm test
```

Runs the Vitest suite — no network calls, no API keys required. Test coverage includes:

- IVR state machine transitions
- Calendar clash detection
- Request validation and date utilities
- Guardrail gate (offer validation against `BookingRequest` rules)
- Caller tool executors (fake LLM, deterministic assertions)
- Intake agent parsing
- Answer interpretation
- Slot book logic
- Receptionist agent with scripted fake LLM
- Speech provider factory (mode selection from config)
- Config loading and env var parsing

```bash
npm run typecheck   # TypeScript type checking without emitting
```

## Architecture

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

**Key seams**

- `PhoneLine` interface — the swap point for real telephony. `SimulatedLine` ships in v1; a `TwilioLine` would implement the same interface without touching the orchestrator.
- `SpeechProvider` interface — `OpenAISpeech` and `BrowserSpeech` are interchangeable at startup based on key availability.
- `CallOrchestrator` — owns turn-taking (half-duplex). Hard limits on turns and wall-clock time prevent runaway loops.

**Data flow per turn**

1. Receptionist speaks → (OpenAI mode) STT transcribes → caller agent receives text
2. Caller agent reasons, calls tools (`press_keys`, `say`, `ask_user`, `confirm_booking` …)
3. Agent speech → (OpenAI mode) TTS → audio streamed to browser for listen-in
4. UI emits `transcript`, `ivr_key`, `hold_start/end`, `needs_user`, `call_ended` events

## Guardrails (enforced in code)

The agent's trustworthiness is not left to prompt-writing alone. Each rule is a code assertion.

| Rule | Enforcement |
|---|---|
| AI disclosure | The caller agent's first utterance must contain the disclosure phrase; a code check in the orchestrator asserts this before the receptionist receives anything |
| Offer gate | `accept_offer` is blocked by a synchronous gate that checks the offered slot against the `BookingRequest` date range, time window and excluded weekdays — a prompt-breaking offer never reaches `book_slot` |
| Calendar clash | The gate also checks the offered slot against `calendar.json`; a clashing slot is declined automatically |
| Fee approval | An offer with `feeGbp` is blocked unless a matching `ask_user` approval is recorded for that offer |
| Data minimisation | `get_profile_field` returns only fields present in `profile.json`; a missing field returns `"ask the user"` — the agent cannot invent or assume values |
| Slot book is source of truth | `book_slot` on the receptionist side runs only after the gate passes; `confirm_booking` must match the slot book record or the run is flagged |

## Known limitations

- **Simulated line only.** There is no real phone call. All receptionist behaviour is scripted via clinic JSON files and a Claude-powered receptionist agent.
- **Half-duplex.** The agent cannot interrupt while the receptionist is speaking, and vice versa. Barge-in and streaming TTS are listed as next steps.
- **Demo data.** `data/profile.json` and `data/clinics/*.json` are static fixtures. No real calendar integration (Google / Outlook) exists in v1.
- **Browser speech mode is Chrome/Edge only.** The Web Speech API's `SpeechRecognition` interface is not available in Firefox or Safari.
- **No persistence.** Sessions are in-memory. `data/calendar.json` is written locally on booking; there is no database or multi-user support.

## Project structure

```
hold-for-me/
├── data/
│   ├── calendar.json          # User's existing events; bookings are appended
│   ├── profile.json           # User name, DOB, phone, existing-patient flags
│   └── clinics/
│       ├── bright-smile.json  # Dental — happy path / clash scenario
│       ├── clearview.json     # Opticians — check-in scenario
│       ├── riverside.json     # Dental — guardrails scenario
│       └── sunny-eyes.json    # Opticians — graceful failure scenario
├── src/
│   ├── cli/
│   │   └── scenario.ts        # CLI scenario runner (text-only, no audio)
│   ├── server/
│   │   ├── index.ts           # Fastify server, WebSocket, session lifecycle
│   │   ├── config.ts          # Env var loading and validation
│   │   ├── data.ts            # Clinic and profile loader
│   │   ├── dates.ts           # Date utilities (slot resolution, clash check)
│   │   ├── calendar.ts        # Calendar read / write
│   │   ├── gate.ts            # Offer guardrail gate
│   │   ├── interpret.ts       # Answer interpreter (Claude Haiku)
│   │   ├── llm.ts             # Anthropic SDK wrapper
│   │   ├── agents/
│   │   │   ├── intake.ts      # IntakeAgent — spoken request → BookingRequest
│   │   │   ├── prompts.ts     # System prompts for all agents
│   │   │   └── callerTools.ts # CallerAgent tool definitions and executors
│   │   ├── line/
│   │   │   ├── ivr.ts         # IVR state machine
│   │   │   ├── slotBook.ts    # Slot book operations
│   │   │   ├── receptionist.ts       # ReceptionistAgent
│   │   │   └── receptionistPrompt.ts # Receptionist system prompt builder
│   │   └── speech/
│   │       ├── SpeechProvider.ts # Interface + factory
│   │       └── openai.ts         # OpenAI STT / TTS implementation
│   ├── shared/
│   │   ├── types.ts           # Shared TypeScript types
│   │   └── protocol.ts        # WebSocket message protocol
│   └── web/                   # React + Vite browser UI
├── tests/                     # Vitest unit and integration tests
├── .env.example
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```
