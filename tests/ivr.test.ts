import { describe, it, expect } from 'vitest';
import { Ivr } from '../src/server/line/ivr.js';
import type { IvrNode } from '../src/server/data.js';

/** Bright Smile Dental IVR: root → hold-node (via '1'), billing (via '2') */
const BRIGHT_SMILE_NODES: IvrNode[] = [
  {
    id: 'root',
    prompt:
      'Thanks for calling Bright Smile Dental. For appointments press 1, for billing press 2.',
    options: { '1': 'hold-node', '2': 'billing' },
  },
  {
    id: 'hold-node',
    prompt: '',
    options: {},
    terminal: 'hold',
  },
  {
    id: 'billing',
    prompt: '',
    options: {},
    terminal: 'closed',
  },
];

/** Two-level IVR: root → sub (via '1'), sub → hold-node (via '2') */
const TWO_LEVEL_NODES: IvrNode[] = [
  {
    id: 'root',
    prompt: 'Press 1 for submenu.',
    options: { '1': 'sub' },
  },
  {
    id: 'sub',
    prompt: 'Press 2 to hold.',
    options: { '2': 'hold-node' },
  },
  {
    id: 'hold-node',
    prompt: '',
    options: {},
    terminal: 'hold',
  },
];

describe('Ivr', () => {
  it('press 1 reaches hold terminal', () => {
    const ivr = new Ivr(BRIGHT_SMILE_NODES);
    const result = ivr.press('1');
    expect(result).toMatchObject({ kind: 'terminal', terminal: 'hold' });
  });

  it('invalid key re-prompts with "Sorry, that\'s not a valid option." + root prompt', () => {
    const ivr = new Ivr(BRIGHT_SMILE_NODES);
    const result = ivr.press('9');
    expect(result.kind).toBe('prompt');
    const text = (result as { kind: 'prompt'; text: string }).text;
    expect(text).toContain("Sorry, that's not a valid option.");
    expect(text).toContain(BRIGHT_SMILE_NODES[0].prompt);
  });

  it('three invalid presses disconnect', () => {
    const ivr = new Ivr(BRIGHT_SMILE_NODES);
    ivr.press('9');
    ivr.press('9');
    const result = ivr.press('9');
    expect(result.kind).toBe('disconnected');
  });

  it('multi-digit string presses each digit in order', () => {
    // '12' on two-level IVR: '1' → sub, '2' → hold-node (terminal)
    const ivr = new Ivr(TWO_LEVEL_NODES);
    const result = ivr.press('12');
    expect(result).toMatchObject({ kind: 'terminal', terminal: 'hold' });

    // '21' on same IVR: '2' invalid on root (counter=1), '1' → sub (non-terminal prompt)
    const ivr2 = new Ivr(TWO_LEVEL_NODES);
    const result2 = ivr2.press('21');
    expect(result2.kind).toBe('prompt');
    expect((result2 as { kind: 'prompt'; text: string }).text).toBe('Press 2 to hold.');
  });

  it('press on a terminal node is a no-op invalid', () => {
    const ivr = new Ivr(BRIGHT_SMILE_NODES);
    // Navigate to terminal hold-node first
    ivr.press('1');
    expect(ivr.current().terminal).toBe('hold');
    // Now press on a terminal node — R3: no-op invalid
    const result = ivr.press('1');
    expect(result.kind).toBe('invalid');
  });
});
