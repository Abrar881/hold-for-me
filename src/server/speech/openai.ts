import OpenAI, { toFile } from 'openai';
import type { Speaker } from '../../shared/types.js';
import type { SpeechProvider } from './SpeechProvider.js';

const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';

export const OPENAI_VOICES: Record<Speaker, string> = {
  agent: 'alloy',
  receptionist: 'coral',
  ivr: 'onyx',
  assistant: 'sage',
  user: 'sage',
};

export class OpenAISpeech implements SpeechProvider {
  readonly mode = 'openai' as const;

  private client: OpenAI;
  private sttModel: string;
  private ttsModel: string;

  constructor(apiKey: string, opts?: { sttModel?: string; ttsModel?: string }) {
    this.client = new OpenAI({ apiKey });
    this.sttModel = opts?.sttModel ?? process.env.OPENAI_STT_MODEL ?? DEFAULT_STT_MODEL;
    this.ttsModel = opts?.ttsModel ?? process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
  }

  async synthesize(
    text: string,
    speaker: Speaker,
    signal?: AbortSignal,
  ): Promise<{ audio: Buffer; mime: string } | null> {
    const voice = OPENAI_VOICES[speaker] ?? OPENAI_VOICES.assistant;

    const response = await this.client.audio.speech.create(
      {
        model: this.ttsModel,
        voice,
        input: text,
        response_format: 'mp3',
      },
      { signal },
    );

    const arrayBuffer = await response.arrayBuffer();
    return { audio: Buffer.from(arrayBuffer), mime: 'audio/mpeg' };
  }

  async transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<string> {
    const file = await toFile(audio, 'audio.webm', { type: mime });

    const result = await this.client.audio.transcriptions.create(
      {
        model: this.sttModel,
        file,
      },
      { signal },
    );

    return result.text;
  }
}
