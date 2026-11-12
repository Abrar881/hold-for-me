# Hold For Me

**Hiya Voice AI Challenge — Productivity track**

## What I built

Hold For Me is a voice agent that phones a clinic on your behalf. You say "book me a check-up at Bright Smile next week, mornings, not Wednesday" — the agent navigates the phone menu, waits on hold, holds a full conversation with the receptionist, and books the appointment. It checks back with you by voice only when a decision needs your approval, then returns a confirmed booking with a transcript and calendar file.

The demo runs locally across four scripted scenarios:
- a happy path with a calendar clash;
- a mid-call check-in;
- guardrails under pressure (a fee and a missing data field);
- a graceful failure when the clinic is closed.

## Key decisions

I chose this problem because it is one of the few everyday tasks that still *only* works by voice. It also sits squarely in Hiya's world of phone calls.

I made three design calls:
- **A simulated phone line.** It has a deterministic phone menu, real hold time, and a Claude-powered receptionist working from a scripted diary. Judges can run it with one API key, and the demo behaves the same every time.
- **A layered speech architecture.** Claude does the reasoning and OpenAI provides natural voices, with automatic fallback to browser speech. It works with one key and sounds best with two.
- **Guardrails enforced in code, not in prompts.** An agent that books things for you has to be trustworthy by construction.

## Who it's for

The primary user is anyone who cannot spare 15 uninterrupted minutes during clinic hours for a call that could be spoken in five seconds. The secondary users are people for whom the call itself is a barrier: phone anxiety, hearing or speech difficulties, limited English. For them this is not a convenience feature — it removes a task they cannot easily do themselves.

## Why voice is the right interface

There are three moments where a keyboard would not work.

The first is the call itself. Clinic booking still happens by phone. Receptionists and phone menus only speak voice; there is no keyboard path to the other end of the line.

The second is the initial request. "Book me a check-up at Bright Smile next week, mornings, not Wednesday" takes five seconds while walking. A form takes longer, and forms are not available when your hands are occupied or your eyes are elsewhere.

The third is the mid-call check-in. When the receptionist offers a slot outside the user's rules, a decision is needed within seconds while the line is live. Hold For Me plays a chime, speaks the question, and starts listening automatically. A spoken answer is the only interaction fast enough for that moment.

## Guardrails enforced in code

The agent's trustworthiness is not left to prompt-writing:
- **AI disclosure.** Every call opens by saying it's an AI assistant. If the agent's first line leaves that out, the orchestrator adds it.
- **The offer gate.** Offers are structured events, and a gate checks every slot against the user's rules (date range, time window, excluded days, calendar clashes) before `accept_offer` can proceed.
- **Approvals.** Fees and out-of-rules slots need the user's spoken approval. That approval is tied to the specific offer the user actually heard, and an ambiguous reply like "okay, what time was it?" never counts as a yes.
- **Source of truth.** The clinic's slot book decides what goes on the result card, not the agent's claim that it booked something.

## What comes next

**Real telephony.** The `PhoneLine` interface is the swap point; a `TwilioLine` would require no changes to the orchestrator.

**Barge-in and streaming TTS.** v1 is half-duplex; interruption and sentence-level streaming would make the conversation feel live.

**Real calendars.** The local JSON stand-in gives way to Google Calendar or Outlook.

**Multilingual.** Many users who need this most are not calling in their first language.

**Clinic-side verification of AI callers.** A clinic receiving an AI-placed call has no way to verify the agent is legitimate or acting with the patient's consent. This is Hiya's domain: the same infrastructure used for caller ID and deepfake voice detection could authenticate AI agents, confirm consent, and give clinics the confidence to accept AI-placed bookings.
