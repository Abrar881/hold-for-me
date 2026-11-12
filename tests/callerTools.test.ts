import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookingRequest, Offer, CalendarEvent, Approval } from '../src/shared/types.js';
import type { Profile } from '../src/server/data.js';
import type { SlotBook } from '../src/server/line/slotBook.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REQ: BookingRequest = {
  clinicId: 'test-clinic',
  service: 'consultation',
  patientName: 'Alex',
  dateFrom: '2026-11-16',
  dateTo: '2026-11-22',
  timeWindow: { start: '08:00', end: '12:00' },
  excludedWeekdays: [],
};

const PROFILE: Profile = {
  name: 'Alex Smith',
  dob: '1990-01-15',
  phone: '07700900000',
  existingPatientAt: ['test-clinic'],
  fields: { address: '10 High St' },
};

const CALENDAR: CalendarEvent[] = [];

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: 'off-1',
    slotId: 'slot-1',
    start: '2026-11-16T09:00',
    end: '2026-11-16T10:00',
    conditions: {},
    ...overrides,
  };
}

function makeBook(offerId = 'off-1', offer?: Offer): ReturnType<typeof makeMockBook> {
  return makeMockBook(offerId, offer ?? makeOffer({ offerId }));
}

function makeMockBook(offerId: string, offer: Offer) {
  return {
    getOffer: vi.fn().mockImplementation((id: string) => (id === offerId ? offer : undefined)),
    markAccepted: vi.fn(),
    acknowledgeFee: vi.fn(),
    provideInfo: vi.fn(),
    book: vi.fn().mockReturnValue({ ok: false, reason: 'not_confirmed' }),
    makeOffer: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    booked: vi.fn().mockReturnValue(undefined),
  } as unknown as SlotBook;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('callerTools', () => {
  let execLocal: (
    name: string,
    input: Record<string, unknown>,
    state: import('../src/server/agents/callerTools.js').CallState,
    book: SlotBook,
  ) => { content: string; isError?: boolean; offerEvent?: unknown } | null;
  let callerToolDefs: import('../src/server/agents/callerTools.js').CallerToolDef[];

  beforeEach(async () => {
    const mod = await import('../src/server/agents/callerTools.js');
    execLocal = mod.execLocal;
    callerToolDefs = mod.callerToolDefs;
  });

  function makeState(
    overrides: Partial<import('../src/server/agents/callerTools.js').CallState> = {},
  ): import('../src/server/agents/callerTools.js').CallState {
    return {
      request: REQ,
      profile: PROFILE,
      calendar: CALENDAR,
      approvals: [],
      offers: new Map(),
      userAnswers: [],
      ...overrides,
    };
  }

  // ── accept_offer tests ───────────────────────────────────────────────────

  it('accept_offer outside window is rejected and slot not marked accepted', async () => {
    // Offer on 2026-11-19 (Thursday) at 15:00–16:00, outside the 08:00–12:00 window
    const offer = makeOffer({
      offerId: 'off-1',
      start: '2026-11-19T15:00',
      end: '2026-11-19T16:00',
    });
    const book = makeBook('off-1', offer);
    const state = makeState({ offers: new Map([['off-1', offer]]) });

    const result = execLocal('accept_offer', { offerId: 'off-1' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(book.markAccepted).not.toHaveBeenCalled();

    // Verify book.book() → not_confirmed when slot wasn't marked
    const bookResult = book.book('off-1', 'Alex');
    expect(bookResult).toEqual({ ok: false, reason: 'not_confirmed' });
  });

  it('accept_offer after slot approval passes and marks accepted', async () => {
    // Offer outside window, but with slot approval → gate passes
    const offer = makeOffer({
      offerId: 'off-2',
      start: '2026-11-19T15:00',
      end: '2026-11-19T16:00',
    });
    const book = makeBook('off-2', offer);
    const approval: Approval = { offerId: 'off-2', kinds: ['slot'] };
    const state = makeState({
      offers: new Map([['off-2', offer]]),
      approvals: [approval],
    });

    const result = execLocal('accept_offer', { offerId: 'off-2' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    expect(result!.content).toContain('Accepted');
    expect(book.markAccepted).toHaveBeenCalledWith('off-2');
  });

  it('accept_offer with fee requires fee approval; after approval acknowledges fee', async () => {
    // Offer with £30 fee, no approval → rejected
    const offer = makeOffer({
      offerId: 'off-3',
      conditions: { feeGbp: 30 },
    });
    const book = makeBook('off-3', offer);
    const state = makeState({ offers: new Map([['off-3', offer]]) });

    const noFeeResult = execLocal('accept_offer', { offerId: 'off-3' }, state, book);
    expect(noFeeResult!.isError).toBe(true);
    expect(book.markAccepted).not.toHaveBeenCalled();

    // With fee approval → passes, acknowledgeFee called
    const feeApproval: Approval = { offerId: 'off-3', kinds: ['fee'] };
    const stateWithApproval = makeState({
      offers: new Map([['off-3', offer]]),
      approvals: [feeApproval],
    });
    const book2 = makeBook('off-3', offer);
    const result2 = execLocal('accept_offer', { offerId: 'off-3' }, stateWithApproval, book2);
    expect(result2!.isError).toBeUndefined();
    expect(book2.markAccepted).toHaveBeenCalledWith('off-3');
    expect(book2.acknowledgeFee).toHaveBeenCalledWith('off-3');
  });

  it('accept_offer unknown id → isError unknown_offer', async () => {
    const book = makeBook('off-1'); // only off-1 exists
    const state = makeState();

    const result = execLocal('accept_offer', { offerId: 'nonexistent-offer' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content).toContain('unknown_offer');
  });

  // ── get_profile_field tests ──────────────────────────────────────────────

  it('get_profile_field insuranceNumber → isError "Not on file"', async () => {
    const book = makeBook('off-1');
    const state = makeState();

    const result = execLocal('get_profile_field', { field: 'insuranceNumber' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
    expect(result!.content).toContain('Not on file');
    expect(result!.content).toContain('ask_user');
  });

  it('get_profile_field for a known top-level field returns the value', async () => {
    const book = makeBook('off-1');
    const state = makeState();

    const result = execLocal('get_profile_field', { field: 'name' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    expect(result!.content).toContain('Alex Smith');
  });

  it('get_profile_field for a known extra field returns the value', async () => {
    const book = makeBook('off-1');
    const state = makeState();

    const result = execLocal('get_profile_field', { field: 'address' }, state, book);

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    expect(result!.content).toContain('10 High St');
  });

  // ── provide_info tests ───────────────────────────────────────────────────

  it('provide_info source user without a prior answer → isError', async () => {
    const book = makeBook('off-1');
    const state = makeState({ userAnswers: [] });

    const result = execLocal(
      'provide_info',
      { offerId: 'off-1', field: 'insuranceNumber', source: 'user' },
      state,
      book,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it('provide_info source user with a prior answer calls provideInfo', async () => {
    const book = makeBook('off-1');
    const state = makeState({
      userAnswers: [{ field: 'insuranceNumber', text: 'INS123' }],
    });

    const result = execLocal(
      'provide_info',
      { offerId: 'off-1', field: 'insuranceNumber', source: 'user' },
      state,
      book,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    expect(book.provideInfo).toHaveBeenCalledWith('off-1', 'insuranceNumber');
  });

  it('provide_info source profile with absent field → isError', async () => {
    const book = makeBook('off-1');
    const state = makeState();

    const result = execLocal(
      'provide_info',
      { offerId: 'off-1', field: 'insuranceNumber', source: 'profile' },
      state,
      book,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBe(true);
  });

  it('provide_info source profile with present field calls provideInfo', async () => {
    const book = makeBook('off-1');
    const state = makeState();

    const result = execLocal(
      'provide_info',
      { offerId: 'off-1', field: 'address', source: 'profile' },
      state,
      book,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    expect(book.provideInfo).toHaveBeenCalledWith('off-1', 'address');
  });

  // ── Line/user tools return null ──────────────────────────────────────────

  it('press_keys returns null (line tool)', async () => {
    const book = makeBook('off-1');
    const state = makeState();
    expect(execLocal('press_keys', { digits: '1' }, state, book)).toBeNull();
  });

  it('say returns null (line tool)', async () => {
    const book = makeBook('off-1');
    const state = makeState();
    expect(execLocal('say', { text: 'hello' }, state, book)).toBeNull();
  });

  it('wait returns null (line tool)', async () => {
    const book = makeBook('off-1');
    const state = makeState();
    expect(execLocal('wait', {}, state, book)).toBeNull();
  });

  it('ask_user returns null (user tool)', async () => {
    const book = makeBook('off-1');
    const state = makeState();
    expect(execLocal('ask_user', { question: 'Is this ok?' }, state, book)).toBeNull();
  });

  it('end_call returns null (user tool)', async () => {
    const book = makeBook('off-1');
    const state = makeState();
    expect(
      execLocal('end_call', { outcome: 'booked', summary: 'Done' }, state, book),
    ).toBeNull();
  });

  // ── check_calendar ───────────────────────────────────────────────────────

  it('check_calendar returns JSON of busy events', async () => {
    const event: CalendarEvent = { title: 'Meeting', start: '2026-11-16T09:00', end: '2026-11-16T10:00' };
    const book = makeBook('off-1');
    const state = makeState({ calendar: [event] });

    const result = execLocal(
      'check_calendar',
      { from: '2026-11-16', to: '2026-11-16' },
      state,
      book,
    );

    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    const parsed = JSON.parse(result!.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Meeting');
  });

  // ── Tool defs ────────────────────────────────────────────────────────────

  it('tool defs are strict with additionalProperties false', () => {
    expect(callerToolDefs.length).toBeGreaterThan(0);
    for (const tool of callerToolDefs) {
      expect(tool.strict).toBe(true);
      expect((tool.input_schema as Record<string, unknown>).additionalProperties).toBe(false);
      expect((tool.input_schema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('all nine expected tools are defined', () => {
    const names = callerToolDefs.map(t => t.name);
    const expected = [
      'press_keys', 'say', 'wait', 'check_calendar',
      'get_profile_field', 'ask_user', 'accept_offer',
      'provide_info', 'end_call',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });
});
