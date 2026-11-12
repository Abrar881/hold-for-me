import { describe, it, expect } from 'vitest';
import { createSpeech, BrowserSpeech } from '../src/server/speech/SpeechProvider.js';
import { OPENAI_VOICES, OpenAISpeech } from '../src/server/speech/openai.js';
import type { Config } from '../src/server/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicKey: 'test-anthropic-key',
    openaiKey: undefined,
    speechMode: 'browser',
    callerModel: 'claude-sonnet-5-5',
    receptionistModel: 'claude-haiku-5-5',
    interpretModel: 'claude-haiku-5-5',
    callerEffort: 'low',
    receptionistEffort: 'low',
    today: '2026-01-01',
    holdScale: 1,
    port: 3001,
    ...overrides,
  };
}

describe('speech factory', () => {
  it('browser mode when no openai key', () => {
    const config = makeConfig({ speechMode: 'browser', openaiKey: undefined });
    const provider = createSpeech(config);
    expect(provider).toBeInstanceOf(BrowserSpeech);
    expect(provider.mode).toBe('browser');
  });

  it('openai voices are distinct per speaker', () => {
    const voices = Object.values(OPENAI_VOICES);
    // agent, receptionist, ivr, assistant should all have distinct voices
    const speakerVoices = [
      OPENAI_VOICES.agent,
      OPENAI_VOICES.receptionist,
      OPENAI_VOICES.ivr,
      OPENAI_VOICES.assistant,
    ];
    const uniqueVoices = new Set(speakerVoices);
    expect(uniqueVoices.size).toBe(speakerVoices.length);
    // user maps to same voice as assistant (sage)
    expect(OPENAI_VOICES.user).toBe(OPENAI_VOICES.assistant);
  });
});
