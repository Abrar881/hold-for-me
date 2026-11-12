/**
 * Pure gating logic for the CheckIn component's auto-listen feature.
 * Extracted for testability in the Node environment.
 *
 * Returns true only when ALL of the following hold:
 *  1. questionUtteranceId is set — the server sent the question utterance after needs_user
 *  2. playedIds contains that id — the Player confirmed it finished playing
 *  3. canSpeak — browser supports speech recognition and microphone
 *  4. !alreadySent — the user has not already submitted an answer
 */
export function shouldStartListening(
  questionUtteranceId: string | undefined,
  playedIds: ReadonlySet<string>,
  canSpeak: boolean,
  alreadySent: boolean,
): boolean {
  if (!questionUtteranceId) return false;              // (a) utterance not received yet
  if (!playedIds.has(questionUtteranceId)) return false; // (b/d) not played, or wrong id
  if (!canSpeak) return false;
  if (alreadySent) return false;
  return true;
}
