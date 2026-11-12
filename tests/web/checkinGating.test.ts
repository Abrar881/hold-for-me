import { describe, it, expect } from 'vitest';
import { shouldStartListening } from '../../src/web/checkinGating.js';

describe('shouldStartListening', () => {
  // Required case (a): needs_user arrived but the question utterance has not yet.
  it('(a) no question utterance id yet → false', () => {
    expect(shouldStartListening(undefined, new Set(), true, false)).toBe(false);
  });

  // Required case (b): question utterance enqueued in Player but not yet played.
  it('(b) question enqueued but not played → false', () => {
    expect(shouldStartListening('q-1', new Set(), true, false)).toBe(false);
  });

  // Required case (c): question utterance has been played → open the mic.
  it('(c) question utterance played → true', () => {
    expect(shouldStartListening('q-1', new Set(['q-1']), true, false)).toBe(true);
  });

  // Required case (d): only call-channel utterances have been played — the specific
  // question utterance id is not in playedIds, so listening must not start.
  it('(d) earlier call-channel utterances played, not the question → false', () => {
    expect(
      shouldStartListening('q-1', new Set(['call-1', 'call-2']), true, false),
    ).toBe(false);
  });

  // Additional guards
  it('false when browser has no speech support', () => {
    expect(shouldStartListening('q-1', new Set(['q-1']), false, false)).toBe(false);
  });

  it('false when answer was already sent', () => {
    expect(shouldStartListening('q-1', new Set(['q-1']), true, true)).toBe(false);
  });

  it('false when all conditions fail', () => {
    expect(shouldStartListening(undefined, new Set(), false, true)).toBe(false);
  });
});
