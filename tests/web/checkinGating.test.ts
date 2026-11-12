import { describe, it, expect } from 'vitest';
import { shouldStartListening } from '../../src/web/checkinGating.js';

describe('shouldStartListening', () => {
  it('false when Player is not yet idle (readyToListen=false)', () => {
    expect(shouldStartListening(false, true, false)).toBe(false);
  });

  it('false when browser has no speech support (canSpeak=false)', () => {
    expect(shouldStartListening(true, false, false)).toBe(false);
  });

  it('false when answer was already sent (alreadySent=true)', () => {
    expect(shouldStartListening(true, true, true)).toBe(false);
  });

  it('true when Player is idle, speech available, nothing sent yet', () => {
    expect(shouldStartListening(true, true, false)).toBe(true);
  });

  it('false when all conditions fail simultaneously', () => {
    expect(shouldStartListening(false, false, true)).toBe(false);
  });
});
