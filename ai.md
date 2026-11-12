# AI tools used

## Design-time: Claude Code

Claude Code was used throughout the design and build of this project.

**Brainstorming and problem selection.** I used Claude Code to explore the problem space and stress-test the choice of problem: why a clinic booking call is a voice-first problem, the three moments where voice is the only viable interface, and the accessibility angle (phone anxiety, hearing difficulties, language barriers).

**Design specification.** Claude Code produced the full design document (`docs/superpowers/specs/2026-11-12-hold-for-me-design.md`), covering the experience, architecture, guardrails approach, scenario definitions, testing strategy, and the rationale for each technical decision (simulated vs real telephony, half-duplex vs real-time, single-key vs two-key speech modes).

**Implementation planning.** Claude Code turned the spec into a task-by-task build plan, ordered by dependency (data files and types first, then core logic, then agents, then orchestrator, then web UI, then docs), with explicit file lists per task.

**Subagent-driven implementation.** Each build task ran as an isolated subagent working in its own git worktree, with a written spec and an acceptance checklist. Completed tasks were reviewed before merging. This kept the main branch green at each step and made the review signal trustworthy.

**Code review.** After each task landed, Claude Code reviewed the diff for correctness, consistency with the spec, and test coverage. Findings were addressed before the next task began.

---

## Runtime: language models

### Caller agent and intake — Claude Sonnet (`claude-sonnet-5-5`)

The caller agent is the highest-stakes reasoning role: it must navigate a live (simulated) conversation, apply the user's rules, call tools correctly, and decide when to interrupt the call for a check-in. Claude Sonnet 5.5 is used here because the task requires coherent multi-turn reasoning and reliable tool use. Server-side refusal fallback (`fallbacks: "default"`) is configured so a content refusal ends the call gracefully rather than crashing the session.

The intake agent (turning a spoken request into a structured `BookingRequest`) also uses this model for reliable structured output parsing.

### Receptionist, answer interpreter — Claude Haiku (`claude-haiku-5-5`)

The simulated receptionist role is narrower: respond in persona, offer slots in the scripted order, enforce clinic-specific quirks (fee disclosure, information requests) through tool calls. Claude Haiku 5.5 is faster and cheaper here, and the shorter latency matters because the receptionist fires on every turn. The answer interpreter (classifying a user's spoken check-in answer as "yes / no / other") also uses Haiku for the same reason.

### Prompt caching

System prompts for both agents use Anthropic's prompt caching to reduce latency and cost on repeated turns within a session.

---

## Runtime: speech

### OpenAI speech (two-key mode)

When `OPENAI_API_KEY` is set, the server uses:

- **STT:** `gpt-4o-mini-transcribe` — transcribes receptionist audio (and the user's mic in listen-in mode) on the server.
- **TTS:** `gpt-4o-mini-tts` — synthesises speech for the caller agent, receptionist and IVR with distinct voices for each speaker, streamed to the browser for listen-in.

This mode sounds natural and works in any modern browser.

### Browser Web Speech (one-key fallback)

When no `OPENAI_API_KEY` is provided, the server sends text to the browser and the browser uses:

- **Output:** `window.speechSynthesis` for the caller agent and receptionist voices.
- **Input:** `window.SpeechRecognition` for the user's mic during the check-in.

In this mode the receptionist-to-caller path skips STT — text is passed directly between agents, and the UI header reflects this. Browser speech requires Chrome or Edge.

---

## My contribution

I acted as product owner and technical lead. I set the direction, made the product and architecture decisions, and ran the build process. Claude Code did the implementation under that direction.

**Product decisions**
- **Chose the problem.** I picked the Productivity track and narrowed it to one concrete, everyday task: phoning a dentist or optician to book an appointment. That call can only be made by voice, it falls inside working hours, and it sits in Hiya's own domain of phone calls.
- **Defined the experience.** You state a request in a few seconds. The agent handles the phone menu, the hold and the receptionist, and checks back with you by voice only when a decision is genuinely yours.
- **Scoped for judges.** I chose a simulated phone line over real telephony so the project runs locally with a single API key and the demo is reliable. Real calls are the planned next step behind the `PhoneLine` interface.

**Architecture decisions**
- **Speech pipeline.** Claude handles reasoning and OpenAI handles speech-to-text and text-to-speech, with automatic fallback to browser voices. The app works with one key and sounds natural with two.
- **Language.** TypeScript end to end, so server and client share types.

**Process**
- I reviewed and approved the design spec and the implementation plan before any code was written.
- I chose subagent-driven development: each task was built by one agent and checked by an independent reviewer agent. I then had independent tasks run in parallel to speed up delivery.
- That review process caught and fixed real issues before merge, including:
  - an approval being accepted for a slot the clinic hadn't offered yet;
  - "okay, what time was it?" being read as agreement;
  - the check-in microphone opening before the question had played.

**What I can walk through in an interview**
- The product reasoning, and why voice is the right interface for each key moment.
- The guardrail design. Approvals and bookings are enforced in code, not trusted to prompts:
  - the offer gate;
  - approvals tied to real offers;
  - the slot book as the single source of truth.
- The architecture trade-offs and the roadmap.
