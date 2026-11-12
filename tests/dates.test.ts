import { describe, it, expect } from 'vitest';
import { resolveRel, weekRange, weekdayOf } from '../src/server/dates.js';

const TODAY = '2026-11-12'; // Thursday

describe('resolveRel', () => {
  it('resolves next-week Tuesday 09:00', () => {
    expect(resolveRel({ weekOffset: 1, weekday: 2, time: '09:00' }, TODAY))
      .toBe('2026-11-17T09:00');
  });

  it('resolves this-week Friday 14:30', () => {
    expect(resolveRel({ weekOffset: 0, weekday: 5, time: '14:30' }, TODAY))
      .toBe('2026-11-13T14:30');
  });
});

describe('weekRange', () => {
  it('returns next-week Mon–Sun from a Thursday', () => {
    expect(weekRange(1, TODAY)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });

  it('returns next-week Mon–Sun even when today is Sunday', () => {
    expect(weekRange(1, '2026-11-15')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });
});

describe('weekdayOf', () => {
  it('returns 4 for a Thursday (2026-11-19)', () => {
    expect(weekdayOf('2026-11-19')).toBe(4);
  });
});
