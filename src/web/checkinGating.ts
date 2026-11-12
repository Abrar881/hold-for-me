/**
 * Pure gating logic for the CheckIn component's auto-listen feature.
 * Extracted for testability in the Node environment.
 *
 * Returns true only when all three conditions hold:
 *  - the Player has finished playing everything queued before the check-in
 *  - the browser supports speech recognition and microphone
 *  - no answer has already been sent for this check-in
 */
export function shouldStartListening(
  readyToListen: boolean,
  canSpeak: boolean,
  alreadySent: boolean,
): boolean {
  return readyToListen && canSpeak && !alreadySent;
}
