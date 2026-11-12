import { describe, it, expect } from 'vitest';
import { interpretAnswer, isClearNo, hasContentBeyondYes } from '../src/server/interpret.js';
import { fakeLlm } from './helpers/fakeLlm.js';

describe('yes fast path (R14)', () => {
  const unclearLlm = () => fakeLlm([{ text: JSON.stringify({ decision: 'unclear', note: 'ambiguous' }) }]);

  it.each(["okay, what time was it?", 'sure, but which day?', 'fine… actually no'])(
    '"%s" is not a fast yes and goes to the llm',
    async answer => {
      const llm = unclearLlm();
      const result = await interpretAnswer(answer, QUESTION, llm);
      expect(llm.calls).toHaveLength(1);
      expect(result.decision).toBe('unclear');
    },
  );

  it.each(["yes that's fine", 'yeah go ahead'])('"%s" is a fast yes', async answer => {
    const llm = fakeLlm([]);
    const result = await interpretAnswer(answer, QUESTION, llm);
    expect(result.decision).toBe('yes');
    expect(llm.calls).toHaveLength(0);
  });

  it('passes the abort signal to the llm call', async () => {
    const signal = new AbortController().signal;
    let seen: AbortSignal | undefined;
    const inner = unclearLlm();
    const llm: typeof inner = Object.assign(
      async (p: Parameters<typeof inner>[0], s?: AbortSignal) => {
        seen = s;
        return inner(p, s);
      },
      { calls: inner.calls },
    );
    await interpretAnswer('hmm, maybe', QUESTION, llm, signal);
    expect(seen).toBe(signal);
  });
});

describe('answer helpers', () => {
  it('isClearNo matches only a leading no', () => {
    expect(isClearNo('no')).toBe(true);
    expect(isClearNo("  Don't know it")).toBe(true);
    expect(isClearNo('AB123456')).toBe(false);
    expect(isClearNo("it's RX-1234")).toBe(false);
  });

  it('hasContentBeyondYes ignores bare agreement', () => {
    expect(hasContentBeyondYes('yes please')).toBe(false);
    expect(hasContentBeyondYes('Yeah, ok, go ahead. Thanks!')).toBe(false);
    expect(hasContentBeyondYes('yes, and my insurance number is RX-1234')).toBe(true);
    expect(hasContentBeyondYes('sure, AB123456')).toBe(true);
  });
});

const QUESTION = 'Can you do Tuesday at 10am?';

describe('interpretAnswer', () => {
  it('"yes that\'s fine" → yes without calling llm', async () => {
    const llm = fakeLlm([]); // empty script — should not be called
    const result = await interpretAnswer("yes that's fine", QUESTION, llm);
    expect(result.decision).toBe('yes');
    expect(llm.calls).toHaveLength(0);
  });

  it('"no, try the week after" → no, note includes "week after"', async () => {
    const llm = fakeLlm([]);
    const result = await interpretAnswer('no, try the week after', QUESTION, llm);
    expect(result.decision).toBe('no');
    expect(result.note).toMatch(/week after/i);
    expect(llm.calls).toHaveLength(0);
  });

  it('"uh what time was that again?" → unclear via llm', async () => {
    const llm = fakeLlm([
      { text: JSON.stringify({ decision: 'unclear', note: 'asked to repeat' }) },
    ]);
    const result = await interpretAnswer('uh what time was that again?', QUESTION, llm);
    expect(result.decision).toBe('unclear');
    expect(result.note).toBe('asked to repeat');
  });

  it('empty string → unclear without llm', async () => {
    const llm = fakeLlm([]);
    const result = await interpretAnswer('', QUESTION, llm);
    expect(result.decision).toBe('unclear');
    expect(llm.calls).toHaveLength(0);
  });

  it('llm returns invalid JSON → unclear (never yes)', async () => {
    const llm = fakeLlm([
      { text: 'this is not json at all }{' },
    ]);
    const result = await interpretAnswer('hmm well maybe sort of', QUESTION, llm);
    expect(result.decision).toBe('unclear');
    expect(result.decision).not.toBe('yes');
  });

  it('llm returns refusal stop → unclear (never yes)', async () => {
    // text is valid yes-JSON so the test fails if the refusal guard is removed
    const llm = fakeLlm([{ text: '{"decision":"yes","note":"x"}', stop: 'refusal' }]);
    const result = await interpretAnswer('hmm well maybe', QUESTION, llm);
    expect(result.decision).toBe('unclear');
    expect(result.decision).not.toBe('yes');
  });
});
