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

I directed this project; Claude Code wrote the code. Being direct about the split:

**Decisions I made**
- Picked the **Productivity** track and the problem: phoning a dentist or optician to book an appointment. It's a task that only works by voice, it lands during working hours, and it sits right in Hiya's domain of phone calls.
- Chose a **simulated phone line** over real Twilio calls so judges can run it locally with one API key and the demo stays predictable. Real telephony is the next step, behind the `PhoneLine` interface.
- Chose the speech architecture: a server pipeline (Claude as the brain, OpenAI speech-to-text and text-to-speech), falling back automatically to browser voices. It runs with one key and sounds natural with two.
- Approved the design spec and implementation plan before any code was written. I then asked for the build to run as parallel subagents with a review after each task, to move faster.
- Decided to ship without live API test runs under time pressure, and to say so openly (see README → Known limitations).

**What AI did**
- Claude Code proposed the design options, wrote the spec and plan, and implemented every task with tests.
- A separate reviewer agent checked each task. Those reviews caught real bugs that were then fixed, for example:
  - the agent could get my approval for a slot the clinic hadn't offered yet;
  - "okay, what time was it?" was being read as a "yes";
  - the check-in microphone opened before the question had played;
  - hold music never started.

**What I can explain**
- The product reasoning and why voice is the right interface.
- The guardrail design: approvals and bookings are enforced in code (the offer gate, and the slot book as the source of truth), not just in prompts.
- The trade-offs in the architecture.
