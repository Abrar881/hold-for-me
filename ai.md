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

*Replace this paragraph with an honest account in your own words before submitting. Describe: which parts of the spec or plan you read carefully and agreed or disagreed with; which design decisions you made yourself or changed; which code you wrote, reviewed line-by-line, or rewrote; and what you would explain confidently in an interview. Judges read ai.md alongside the code — a vague placeholder here raises questions.*
