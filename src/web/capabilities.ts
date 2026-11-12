export interface Capabilities {
  recognition: boolean;
  synthesis: boolean;
  recorder: boolean;
  mic: boolean;
}

/** Detect which Web Speech / MediaRecorder APIs are available.
 *  Accepts a duck-typed window so the function is pure and testable in Node. */
export function detectCapabilities(win: {
  navigator?: any;
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
  speechSynthesis?: any;
  MediaRecorder?: any;
}): Capabilities {
  return {
    recognition: !!(win.SpeechRecognition || win.webkitSpeechRecognition),
    synthesis: !!(win.speechSynthesis),
    recorder: !!(win.MediaRecorder),
    mic: !!(win.navigator?.mediaDevices?.getUserMedia),
  };
}
