import type { SpeechMode, Speaker } from '../../shared/types.js';
import type { Config } from '../config.js';
import { OpenAISpeech } from './openai.js';

export interface SpeechProvider {
  mode: SpeechMode;
  synthesize(text: string, speaker: Speaker, signal?: AbortSignal): Promise<{ audio: Buffer; mime: string } | null>;
  transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<string>;
}

export class BrowserSpeech implements SpeechProvider {
  readonly mode: SpeechMode = 'browser';

  async synthesize(_text: string, _speaker: Speaker, _signal?: AbortSignal): Promise<{ audio: Buffer; mime: string } | null> {
    return null;
  }

  async transcribe(_audio: Buffer, _mime: string, _signal?: AbortSignal): Promise<string> {
    throw new Error('browser mode: client sends text');
  }
}

export function createSpeech(config: Config): SpeechProvider {
  if (config.speechMode === 'openai' && config.openaiKey) {
    return new OpenAISpeech(config.openaiKey, {
      sttModel: process.env.OPENAI_STT_MODEL,
      ttsModel: process.env.OPENAI_TTS_MODEL,
    });
  }
  return new BrowserSpeech();
}
