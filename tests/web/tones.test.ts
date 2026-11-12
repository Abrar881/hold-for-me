import { describe, it, expect } from 'vitest';
import { dtmfFreqs } from '../../src/web/tones.js';

describe('dtmfFreqs', () => {
  it("dtmfFreqs('1') = [697, 1209]", () => {
    expect(dtmfFreqs('1')).toEqual([697, 1209]);
  });

  it("dtmfFreqs('2') = [697, 1336]", () => {
    expect(dtmfFreqs('2')).toEqual([697, 1336]);
  });

  it("dtmfFreqs('3') = [697, 1477]", () => {
    expect(dtmfFreqs('3')).toEqual([697, 1477]);
  });

  it("dtmfFreqs('4') = [770, 1209]", () => {
    expect(dtmfFreqs('4')).toEqual([770, 1209]);
  });

  it("dtmfFreqs('5') = [770, 1336]", () => {
    expect(dtmfFreqs('5')).toEqual([770, 1336]);
  });

  it("dtmfFreqs('6') = [770, 1477]", () => {
    expect(dtmfFreqs('6')).toEqual([770, 1477]);
  });

  it("dtmfFreqs('7') = [852, 1209]", () => {
    expect(dtmfFreqs('7')).toEqual([852, 1209]);
  });

  it("dtmfFreqs('8') = [852, 1336]", () => {
    expect(dtmfFreqs('8')).toEqual([852, 1336]);
  });

  it("dtmfFreqs('9') = [852, 1477]", () => {
    expect(dtmfFreqs('9')).toEqual([852, 1477]);
  });

  it("dtmfFreqs('*') = [941, 1209]", () => {
    expect(dtmfFreqs('*')).toEqual([941, 1209]);
  });

  it("dtmfFreqs('0') = [941, 1336]", () => {
    expect(dtmfFreqs('0')).toEqual([941, 1336]);
  });

  it("dtmfFreqs('#') = [941, 1477]", () => {
    expect(dtmfFreqs('#')).toEqual([941, 1477]);
  });

  it("dtmfFreqs('x') throws", () => {
    expect(() => dtmfFreqs('x')).toThrow();
  });

  it("dtmfFreqs('') throws", () => {
    expect(() => dtmfFreqs('')).toThrow();
  });
});
