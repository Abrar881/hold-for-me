import { describe, it, expect } from 'vitest';
import { Intake } from '../src/server/agents/intake.js';
import { fakeLlm } from './helpers/fakeLlm.js';
import type { Clinic, Profile } from '../src/server/data.js';

// Fixed "today" so weekRange(1, TODAY) gives a deterministic result.
// weekRange(1, '2026-11-12') → { from: '2026-11-16', to: '2026-11-22' }
const TODAY = '2026-11-12';

const clinics: Clinic[] = [
  {
    id: 'riverside',
    name: 'Riverside Dental',
    service: 'dental',
    receptionistName: 'Tom',
    persona: 'Thorough dental coordinator',
    holdSeconds: 3,
    ivr: [],
    slots: [],
    quirks: {},
    demoRequest: 'Book me at Riverside Dental next week',
  },
  {
    id: 'bright-smile',
    name: 'Bright Smile Dental',
    service: 'dental',
    receptionistName: 'Sarah',
    persona: 'Warm dental receptionist',
    holdSeconds: 8,
    ivr: [],
    slots: [],
    quirks: {},
    demoRequest: 'Book me at Bright Smile next week',
  },
];

const profile: Profile = {
  name: 'Alice Smith',
  dob: '1990-01-01',
  phone: '555-1234',
  existingPatientAt: [],
  fields: {},
};

function makeIntake(llm: ReturnType<typeof fakeLlm>) {
  return new Intake(clinics, profile, TODAY, llm);
}

/** Build a valid full-output JSON string with optional field overrides. */
function okJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clinicId: 'riverside',
    service: 'dental check-up',
    dateFrom: '2026-11-16',
    dateTo: '2026-11-22',
    timeWindow: 'mornings',
    excludedWeekdays: [3],
    notes: null,
    clarifyingQuestion: null,
    summary: 'Dental check-up at Riverside Dental next week mornings excluding Wednesdays',
    ...overrides,
  });
}

describe('Intake agent', () => {
  it('full request becomes ready with excludedWeekdays [3] and window 08:00–12:00', async () => {
    const llm = fakeLlm([{ text: okJson() }]);
    const intake = makeIntake(llm);

    const result = await intake.hear('Book me at Riverside Dental next week mornings not Wednesdays');

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;

    expect(result.request.excludedWeekdays).toEqual([3]);
    expect(result.request.timeWindow).toEqual({ start: '08:00', end: '12:00' });
    expect(result.request.patientName).toBe('Alice Smith');
    expect(result.request.clinicId).toBe('riverside');
    expect(result.request.dateFrom).toBe('2026-11-16');
    expect(result.request.dateTo).toBe('2026-11-22');
    expect(result.summary).toBe(
      'Dental check-up at Riverside Dental next week mornings excluding Wednesdays',
    );
  });

  it('missing clinic yields clarifying question; then hear("Bright Smile") → ready (assert history has 2 user turns)', async () => {
    const clarifyJson = JSON.stringify({
      clinicId: null,
      service: null,
      dateFrom: null,
      dateTo: null,
      timeWindow: null,
      excludedWeekdays: null,
      notes: null,
      clarifyingQuestion: 'Which clinic would you like to book at?',
      summary: 'Patient wants to book next week',
    });

    const readyJson = JSON.stringify({
      clinicId: 'bright-smile',
      service: null,
      dateFrom: null,
      dateTo: null,
      timeWindow: null,
      excludedWeekdays: null,
      notes: null,
      clarifyingQuestion: null,
      summary: 'Book at Bright Smile Dental next week',
    });

    const llm = fakeLlm([{ text: clarifyJson }, { text: readyJson }]);
    const intake = makeIntake(llm);

    // First turn: clinic unknown → question
    const q = await intake.hear('Book me next week');
    expect(q.kind).toBe('question');
    if (q.kind !== 'question') return;
    expect(q.question).toBe('Which clinic would you like to book at?');

    // Second turn: clinic resolved → ready
    const r = await intake.hear('Bright Smile');
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.request.clinicId).toBe('bright-smile');
    // Service defaults to clinic.service when not specified
    expect(r.request.service).toBe('dental');
    // Dates default to next week
    expect(r.request.dateFrom).toBe('2026-11-16');
    expect(r.request.dateTo).toBe('2026-11-22');
    // Time defaults to 08:00–18:00
    expect(r.request.timeWindow).toEqual({ start: '08:00', end: '18:00' });
    // Patient name from profile
    expect(r.request.patientName).toBe('Alice Smith');

    // History must contain 2 user turns in the second LLM call
    expect(llm.calls).toHaveLength(2);
    const secondMessages = llm.calls[1].messages as Array<{ role: string }>;
    const userTurns = secondMessages.filter(m => m.role === 'user');
    expect(userTurns).toHaveLength(2);
  });

  it('unknown clinic id from model is treated as missing', async () => {
    const llm = fakeLlm([
      {
        text: JSON.stringify({
          clinicId: 'totally-unknown-xyz',
          service: null,
          dateFrom: '2026-11-16',
          dateTo: '2026-11-22',
          timeWindow: null,
          excludedWeekdays: null,
          notes: null,
          clarifyingQuestion: null,
          summary: 'Some booking at an unknown clinic',
        }),
      },
    ]);
    const intake = makeIntake(llm);

    const result = await intake.hear('Book me somewhere');
    expect(result.kind).toBe('question');
  });

  it('past date range yields question', async () => {
    const llm = fakeLlm([
      {
        text: JSON.stringify({
          clinicId: 'riverside',
          service: 'dental',
          dateFrom: '2026-11-01',
          dateTo: '2026-11-07',
          timeWindow: null,
          excludedWeekdays: null,
          notes: null,
          clarifyingQuestion: null,
          summary: 'Booking in early November',
        }),
      },
    ]);
    const intake = makeIntake(llm);

    const result = await intake.hear('Book me first week of November');
    expect(result.kind).toBe('question');
  });

  it('invalid JSON yields "Sorry, could you say that again?" question', async () => {
    const llm = fakeLlm([{ text: 'not valid json }{' }]);
    const intake = makeIntake(llm);

    const result = await intake.hear('Some garbled request');
    expect(result.kind).toBe('question');
    if (result.kind !== 'question') return;
    expect(result.question).toBe('Sorry, could you say that again?');
  });
});
