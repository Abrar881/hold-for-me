export interface SpeechResult {
  final: boolean;
  text: string;
}

export type SpeechCallback = (result: SpeechResult) => void;

/**
 * Start a single-utterance SpeechRecognition session.
 * Returns a stop function. Calls onEnd when the session ends.
 * Throws if recognition is not supported.
 */
export function startListening(
  onResult: SpeechCallback,
  onEnd: () => void,
): () => void {
  const SpeechRec =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;

  if (!SpeechRec) {
    throw new Error('Speech recognition not supported in this browser');
  }

  const rec = new SpeechRec() as any;
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = 'en-GB';

  rec.onresult = (event: any) => {
    const result = event.results[event.resultIndex];
    onResult({
      final: result.isFinal,
      text: result[0].transcript,
    });
  };

  rec.onend = onEnd;
  rec.start();

  return () => {
    try {
      rec.stop();
    } catch {
      // already stopped
    }
  };
}
