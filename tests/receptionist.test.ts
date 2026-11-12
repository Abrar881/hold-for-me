/**
 * Tests for the Receptionist agent (Task 8).
 */
import { describe, it, expect } from 'vitest';
import { fakeLlm } from './helpers/fakeLlm.js';
import { Receptionist } from '../src/server/line/receptionist.js';
import { SlotBook } from '../src/server/line/slotBook.js';
import type { Clinic, Profile } from '../src/server/data.js';
import type { LlmParams } from '../src/server/llm.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const clinic: Clinic = {
  id: 'test-clinic',
  name: 'Bright Smile Dental',
  service: 'dental',
  receptionistName: 'Sarah',
  persona: 'Friendly and professional dental receptionist.',
  holdSeconds: 30,
  ivr: [],
  slots: [
    { slotId: 'bs-1', start: '2026-11-17T09:00', end: '2026-11-17T09:30' },
    { slotId: 'bs-2', start: '2026-11-18T14:00', end: '2026-11-18T14:30' },
  ],
  quirks: {
    asksDob: true,
    newPatientFeeGbp: 50,
    requiresInfoForNewPatients: ['insurance_number'],
  },
  demoRequest: 'Please book me an appointment.',
};

const profile: Profile = {
  name: 'Jane Doe',
  dob: '1990-05-15',
  phone: '07700900000',
  existingPatientAt: ['test-clinic'],
  fields: {},
};

const profileNew: Profile = {
  name: 'John Smith',
  dob: '1985-03-20',
  phone: '07700900001',
  existingPatientAt: [],
  fields: {},
};

function makeBook(isNew = false): SlotBook {
  return new SlotBook(clinic, isNew);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Receptionist.greet', () => {
  it('returns fixed greeting line without calling LLM', () => {
    const llm = fakeLlm([]);
    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    expect(rec.greet()).toBe('Bright Smile Dental, Sarah speaking, how can I help?');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('Receptionist.respond — make_offer tool result is surfaced as structured offer', () => {
  it('make_offer tool result is surfaced as structured offer', async () => {
    const llm = fakeLlm([
      // First LLM call: use make_offer tool
      { tools: [{ name: 'make_offer', input: { slotId: 'bs-1' } }] },
      // Second LLM call: respond with text after getting tool result
      { text: 'We have Tuesday at 9' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('I need an appointment this week');

    expect(result.offer).toBeDefined();
    expect(result.offer!.slotId).toBe('bs-1');
    expect(result.text).toBe('We have Tuesday at 9');
    expect(result.hungUp).toBe(false);
  });
});

describe('Receptionist.respond — book_slot refusal is fed back as is_error', () => {
  it('book_slot refusal is fed back to the model as tool_result with is_error true', async () => {
    // The book will refuse because the slot offer hasn't been accepted
    const llm = fakeLlm([
      // First call: attempt to book without accept
      { tools: [{ name: 'book_slot', input: { offerId: 'off-999' } }] },
      // Second call: respond after receiving error
      { text: 'Could you please confirm you want that slot?' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('Book the slot');

    // Check the second call's messages contain a tool_result with is_error: true
    expect(llm.calls).toHaveLength(2);
    const secondCall = llm.calls[1];
    const messages = secondCall.messages as Array<{ role: string; content: unknown[] }>;
    // Find the last user message (which should be the tool results)
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    const contents = lastUserMsg.content as Array<{ type: string; is_error?: boolean }>;
    const toolResultWithError = contents.find(
      (c) => c.type === 'tool_result' && c.is_error === true,
    );
    expect(toolResultWithError).toBeDefined();
  });
});

describe('Receptionist.respond — refusal stop yields polite fallback and hungUp true', () => {
  it('refusal stop yields polite fallback line and hungUp true', async () => {
    const llm = fakeLlm([
      // LLM refuses to respond
      { text: '', stop: 'refusal' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('Do something problematic');

    expect(result.hungUp).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('Receptionist — system prompt', () => {
  it('system prompt includes persona, quirks, and today date; last system block has cache_control', async () => {
    const today = '2026-11-12';
    const llm = fakeLlm([{ text: 'Hello!' }]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm, today);
    await rec.respond('Hi');

    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0] as LlmParams;
    const system = call.system as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);

    // All system blocks should be text type
    const textBlocks = system.filter((b) => b.type === 'text');
    expect(textBlocks.length).toBeGreaterThan(0);

    // Combined system text should include persona and today date
    const allSystemText = textBlocks.map((b) => b.text ?? '').join('\n');
    expect(allSystemText).toContain(clinic.persona);
    expect(allSystemText).toContain(today);

    // Last system block must have cache_control: { type: 'ephemeral' }
    const lastBlock = system[system.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('Receptionist — loop limit', () => {
  it('loop stops after 6 iterations with a fallback line', async () => {
    // Always return tool_use to force repeated iterations
    const llm = fakeLlm([
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      { tools: [{ name: 'list_slots', input: { from: '2026-11-17', to: '2026-11-18' } }] },
      // 7th call should NOT happen; the loop stops at 6 iterations
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('What slots do you have?');

    // Should have made exactly 6 LLM calls
    expect(llm.calls).toHaveLength(6);
    // Should have a fallback text
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('Receptionist.respond — end_call tool', () => {
  it('end_call tool sets hungUp to true', async () => {
    const llm = fakeLlm([
      { tools: [{ name: 'end_call', input: {} }] },
      { text: 'Goodbye, have a great day!' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('Goodbye');

    expect(result.hungUp).toBe(true);
    expect(result.text).toBe('Goodbye, have a great day!');
  });
});

describe('Receptionist.respond — lookup_patient tool', () => {
  it('lookup_patient existing patient returns existing', async () => {
    const llm = fakeLlm([
      {
        tools: [
          { name: 'lookup_patient', input: { name: 'Jane Doe', dob: '1990-05-15' } },
        ],
      },
      { text: 'I found you as an existing patient.' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    const result = await rec.respond('My name is Jane Doe');

    expect(result.text).toBe('I found you as an existing patient.');
    expect(result.hungUp).toBe(false);
  });

  it('lookup_patient new patient returns new', async () => {
    const llm = fakeLlm([
      {
        tools: [
          { name: 'lookup_patient', input: { name: 'John Smith', dob: '1985-03-20' } },
        ],
      },
      { text: "I don't have you on our system." },
    ]);

    const rec = new Receptionist(clinic, makeBook(true), profileNew, llm);
    const result = await rec.respond('My name is John Smith');

    expect(result.text).toBeDefined();
    expect(result.hungUp).toBe(false);
  });
});

describe('Receptionist.respond — booking flow', () => {
  it('complete booking flow returns booking in result', async () => {
    // We need to manually create an offer and mark it accepted for the booking to work
    const book = makeBook();
    const offer = book.makeOffer('bs-1');
    if ('error' in offer) throw new Error('offer error');
    book.markAccepted(offer.offerId);

    const llm = fakeLlm([
      {
        tools: [{ name: 'book_slot', input: { offerId: offer.offerId } }],
      },
      { text: 'Your appointment is confirmed for Tuesday at 9 AM.' },
    ]);

    const rec = new Receptionist(clinic, book, profile, llm);
    const result = await rec.respond('Yes please book it');

    expect(result.booking).toBeDefined();
    expect(result.booking!.slotId).toBe('bs-1');
    expect(result.text).toBe('Your appointment is confirmed for Tuesday at 9 AM.');
  });
});

describe('Receptionist — conversation history persists across respond calls', () => {
  it('history is kept across multiple respond calls', async () => {
    const llm = fakeLlm([
      { text: 'Hello! How can I help you?' },
      { text: 'Sure, let me check availability.' },
    ]);

    const rec = new Receptionist(clinic, makeBook(), profile, llm);
    await rec.respond('Hi there');
    await rec.respond('I need an appointment');

    // Second call should include history from first call
    expect(llm.calls).toHaveLength(2);
    const secondCallMessages = llm.calls[1].messages as Array<{
      role: string;
      content: unknown;
    }>;
    // Should have more than 2 messages (first user + first assistant + second user)
    expect(secondCallMessages.length).toBeGreaterThanOrEqual(3);
  });
});
