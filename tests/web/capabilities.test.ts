import { describe, it, expect } from 'vitest';
import { detectCapabilities } from '../../src/web/capabilities.js';

describe('detectCapabilities', () => {
  it('Firefox-like (no SpeechRecognition) → recognition false', () => {
    const result = detectCapabilities({});
    expect(result.recognition).toBe(false);
  });

  it('webkit prefix counts as recognition', () => {
    const result = detectCapabilities({ webkitSpeechRecognition: class {} });
    expect(result.recognition).toBe(true);
  });

  it('standard SpeechRecognition counts as recognition', () => {
    const result = detectCapabilities({ SpeechRecognition: class {} });
    expect(result.recognition).toBe(true);
  });

  it('no speechSynthesis → synthesis false', () => {
    const result = detectCapabilities({});
    expect(result.synthesis).toBe(false);
  });

  it('speechSynthesis present → synthesis true', () => {
    const result = detectCapabilities({ speechSynthesis: {} });
    expect(result.synthesis).toBe(true);
  });

  it('no MediaRecorder → recorder false', () => {
    const result = detectCapabilities({});
    expect(result.recorder).toBe(false);
  });

  it('navigator.mediaDevices.getUserMedia → mic true', () => {
    const result = detectCapabilities({
      navigator: { mediaDevices: { getUserMedia: () => {} } },
    });
    expect(result.mic).toBe(true);
  });

  it('no navigator → mic false', () => {
    const result = detectCapabilities({});
    expect(result.mic).toBe(false);
  });
});
