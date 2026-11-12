# Hold For Me

**Hiya Voice AI Challenge — Productivity track**

## What I built

Hold For Me is a voice agent that phones a clinic on your behalf. You say "book me a check-up at Bright Smile next week, mornings, not Wednesday" — the agent navigates the phone menu, waits on hold, holds a full conversation with the receptionist, and books the appointment. It checks back with you by voice only when a decision needs your approval, then returns a confirmed booking with a transcript and calendar file.

The demo runs locally across four scripted scenarios: a happy path with a calendar clash, a mid-call check-in, guardrails under pressure (a fee and a missing data field), and a graceful failure when the clinic is closed.

## Who it's for

The primary user is anyone who cannot spare 15 uninterrupted minutes during clinic hours for a call that could be spoken in five seconds. The secondary users are people for whom the call itself is a barrier: phone anxiety, hearing or speech difficulties, limited English. For them this is not a convenience feature — it removes a task they cannot easily do themselves.

## Why voice is the right interface

There are three moments where a keyboard would not work.

The first is the call itself. Clinic booking still happens by phone. Receptionists and phone menus only speak voice; there is no keyboard path to the other end of the line.

The second is the initial request. "Book me a check-up at Bright Smile next week, mornings, not Wednesday" takes five seconds while walking. A form takes longer, and forms are not available when your hands are occupied or your eyes are elsewhere.

The third is the mid-call check-in. When the receptionist offers a slot outside the user's rules, a decision is needed within seconds while the line is live. Hold For Me plays a chime, speaks the question, and starts listening automatically. A spoken answer is the only interaction fast enough for that moment.

## Guardrails enforced in code

The agent's trustworthiness is not left to prompt-writing. At the start of every call the orchestrator checks the agent's first utterance for the AI disclosure phrase before the receptionist receives a word. Offers are structured events: a synchronous gate validates every slot against the user's rules (date range, time window, excluded days, calendar clashes) before `accept_offer` can proceed. Any offer with a fee or a data request is blocked until the user approves it by voice. The slot book, not the agent's confirmation, is the source of truth for the result card.

## What comes next

**Real telephony.** The `PhoneLine` interface is the swap point; a `TwilioLine` would require no changes to the orchestrator.

**Barge-in and streaming TTS.** v1 is half-duplex; interruption and sentence-level streaming would make the conversation feel live.

**Real calendars.** The local JSON stand-in gives way to Google Calendar or Outlook.

**Multilingual.** Many users who need this most are not calling in their first language.

**Clinic-side verification of AI callers.** A clinic receiving an AI-placed call has no way to verify the agent is legitimate or acting with the patient's consent. This is Hiya's domain: the same infrastructure used for caller ID and deepfake voice detection could authenticate AI agents, confirm consent, and give clinics the confidence to accept AI-placed bookings.
