/**
 * Tests for the CLI scenario runner (Task 13).
 *
 * These tests run the full pipeline in memory using fakeLlm stubs so that no
 * API key is needed.  They cover:
 *
 *  1. bright-smile → booked at Thu 10:30 with no needs_user (ask_user never called)
 *  2. riverside per-clinic default answer (R4) is the insurance string
 */
import { describe, it, expect } from 'vitest';
import { runScenario, defaultAnswer } from '../src/cli/scenario.js';
import type { ScenarioResult } from '../src/cli/scenario.js';
import { fakeLlm } from './helpers/fakeLlm.js';

// Fixed "today" matches the one used throughout the test suite.
// weekRange(1, '2026-11-12') → { from: '2026-11-16', to: '2026-11-22' }
// bright-smile slot bs-2: weekOffset=1, weekday=4 (Thu) → 2026-11-19T10:30
const TODAY = '2026-11-12';

// ─── Test 1: bright-smile booking, no needs_user ───────────────────────────────

describe('runScenario("bright-smile")', () => {
  it('books the Thursday 10:30 slot without asking the user', async () => {
    // ── Intake LLM ──────────────────────────────────────────────────────────
    // Returns structured JSON that maps the demoRequest to clinic "bright-smile",
    // mornings time window, excluding Wednesday (0=Sun, 1=Mon, 2=Tue, 3=Wed).
    const intakeLlm = fakeLlm([
      {
        text: JSON.stringify({
          clinicId: 'bright-smile',
          service: 'dental check-up',
          dateFrom: null,
          dateTo: null,
          timeWindow: 'mornings',
          excludedWeekdays: [3], // Wednesday (0=Sun..6=Sat)
          notes: null,
          clarifyingQuestion: null,
          summary: 'Book a dental check-up at Bright Smile next week, mornings, not Wednesday.',
        }),
      },
    ]);

    // ── Receptionist LLM ─────────────────────────────────────────────────────
    // Call 1: make_offer for slot bs-2 (Thu 10:30)
    // Call 2: text response after offer tool result
    // Call 3: book_slot once the caller verbally accepts
    // Call 4: confirmation text after booking tool result
    const recLlm = fakeLlm([
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-2' } }] },
      { text: 'We have Thursday the 19th at 10:30 AM. Would you like to book that?' },
      { tools: [{ name: 'book_slot', input: { offerId: 'off-1' } }] },
      { text: "You're all set! Booked for Thursday the 19th at 10:30. See you then!" },
    ]);

    // ── Caller LLM ────────────────────────────────────────────────────────────
    // 1. Navigate IVR: press 1 to reach appointments queue
    // 2. Introduce as AI assistant and ask about dental check-up
    // 3. Gate check: accept the offered slot (passes: Thu 10:30 ∈ mornings, not Wed)
    // 4. Verbally confirm the booking to the receptionist
    // 5. End the call as booked
    const callerLlm = fakeLlm([
      { tools: [{ name: 'press_keys', input: { digits: '1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: {
              text: "Hi, I'm an AI assistant calling on behalf of Alex Khan to book a dental check-up.",
            },
          },
        ],
      },
      { tools: [{ name: 'accept_offer', input: { offerId: 'off-1' } }] },
      {
        tools: [
          {
            name: 'say',
            input: { text: 'Yes please, could you book the Thursday 10:30 slot for Alex Khan?' },
          },
        ],
      },
      {
        tools: [
          {
            name: 'end_call',
            input: {
              outcome: 'booked',
              summary: 'Booked dental check-up at Bright Smile for Thursday the 19th at 10:30.',
            },
          },
        ],
      },
    ]);

    // Interpret LLM is not needed (no ask_user call in this scenario)
    const interpretLlm = fakeLlm([]);

    const result: ScenarioResult = await runScenario({
      clinicId: 'bright-smile',
      fast: true,
      llms: { caller: callerLlm, receptionist: recLlm, intake: intakeLlm, interpret: interpretLlm },
      dataDir: 'data',
      today: TODAY,
    });

    const { outcome, needsUserFired } = result;

    // Outcome must be booked
    expect(outcome.status).toBe('booked');

    // Booking must be for the Thursday 10:30 slot
    expect(outcome.booking).toBeDefined();
    expect(outcome.booking!.start).toContain('10:30');
    expect(outcome.booking!.clinicId).toBe('bright-smile');

    // No needs_user event must have fired (bright-smile is an existing patient, no fee/info required)
    expect(needsUserFired).toBe(false);

    // Transcript should not be empty
    expect(outcome.transcript.length).toBeGreaterThan(0);
  });
});

// ─── Test 2: riverside per-clinic default answer (R4) ─────────────────────────

describe('defaultAnswer (R4)', () => {
  it('returns the insurance string for riverside', () => {
    expect(defaultAnswer('riverside')).toBe('yes, and my insurance number is AB123456');
  });

  it('returns "yes" for other clinics', () => {
    expect(defaultAnswer('bright-smile')).toBe('yes');
    expect(defaultAnswer('clearview')).toBe('yes');
    expect(defaultAnswer('sunny-eyes')).toBe('yes');
    expect(defaultAnswer('unknown-clinic')).toBe('yes');
  });
});
