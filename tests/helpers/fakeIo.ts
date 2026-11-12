import type { CallIO } from '../../src/server/orchestrator.js';
import type { SpeechProvider } from '../../src/server/speech/SpeechProvider.js';
import type { ServerMsg } from '../../src/shared/protocol.js';
import type { SpeechMode, Speaker } from '../../src/shared/types.js';

export interface SpokenRecord {
  id: string;
  speaker: Speaker;
  text: string;
  channel: 'call' | 'user';
  audio: { audio: Buffer; mime: string } | null;
}

export type FakeIo = CallIO & {
  emitted: ServerMsg[];
  spoken: SpokenRecord[];
  asked: { question: string; timeoutMs: number; attempt: number }[];
};

/**
 * Records every emit/speak and answers askUser from a script.
 * `null` in the script (or an exhausted script) simulates a timeout.
 */
export function fakeIo(answers: (string | null)[] = []): FakeIo {
  const queue = [...answers];
  const emitted: ServerMsg[] = [];
  const spoken: SpokenRecord[] = [];
  const asked: FakeIo['asked'] = [];

  return {
    emitted,
    spoken,
    asked,
    emit: msg => {
      emitted.push(msg);
    },
    speak: async (u, audio) => {
      spoken.push({ ...u, audio });
    },
    askUser: async (question, timeoutMs, attempt) => {
      asked.push({ question, timeoutMs, attempt });
      return queue.length > 0 ? (queue.shift() ?? null) : null;
    },
  };
}

/** Fake speech provider; defaults are browser-style (no audio, transcribe unused). */
export function fakeSpeech(opts: {
  mode: SpeechMode;
  synthesize?: SpeechProvider['synthesize'];
  transcribe?: SpeechProvider['transcribe'];
}): SpeechProvider {
  return {
    mode: opts.mode,
    synthesize: opts.synthesize ?? (async () => null),
    transcribe:
      opts.transcribe ??
      (async () => {
        throw new Error('fakeSpeech: transcribe not configured');
      }),
  };
}
