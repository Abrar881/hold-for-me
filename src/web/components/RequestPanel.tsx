import { useState, useEffect, useCallback, useRef } from 'react';
import type { ClientMsg } from '../../shared/protocol.js';
import type { SocketState } from '../ws.js';
import type { Capabilities } from '../capabilities.js';
import { startListening } from '../browserSpeech.js';
import { Recorder } from '../recorder.js';

interface Props {
  state: SocketState;
  capabilities: Capabilities;
  send: (m: ClientMsg) => void;
}

const MicIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);

export function RequestPanel({ state, capabilities, send }: Props) {
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [selectedScenario, setSelectedScenario] = useState('');
  const [micError, setMicError] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<Recorder | null>(null);

  // Keep refs current so the stable spacebar effect closure can read them.
  const canSpeakRef = useRef(capabilities.recognition && capabilities.mic);
  canSpeakRef.current = capabilities.recognition && capabilities.mic;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;
  const speechModeRef = useRef(state.speechMode);
  speechModeRef.current = state.speechMode;
  // interimRef lets stopRecording always read the latest interim without
  // being included in its useCallback deps — eliminates the stale closure
  // that caused the spacebar PTT to drop dictated text in browser speech mode.
  const interimRef = useRef(interim);
  interimRef.current = interim;

  const canSpeak = capabilities.recognition && capabilities.mic;
  const isUnderstanding = state.phase === 'understanding';

  const startRecording = useCallback(() => {
    if (recordingRef.current) return;
    setMicError(false);
    setRecording(true);
    setInterim('');
    setFinalText('');

    if (speechModeRef.current === 'openai') {
      const rec = new Recorder();
      recorderRef.current = rec;
      // PTT mode: autoStop false — user releases button/key to stop
      rec.start({ autoStop: false, maxMs: 60000 })
        .then(blob => {
          recorderRef.current = null;
          setRecording(false);
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1];
            send({ type: 'user_utterance', audioB64: base64, mime: blob.type });
          };
          reader.readAsDataURL(blob);
        })
        .catch(() => {
          recorderRef.current = null;
          setRecording(false);
          setMicError(true);
        });
    } else {
      try {
        stopRef.current = startListening(
          (result) => {
            setInterim(result.text);
            if (result.final) setFinalText(result.text);
          },
          () => {
            setRecording(false);
          },
        );
      } catch {
        setRecording(false);
        setMicError(true);
      }
    }
  }, [send]);

  // stopRecording does NOT list `interim` as a dep — instead it reads
  // interimRef.current, which is always the latest value. This means the
  // function identity is stable, so the [] -deps spacebar effect captures the
  // correct version and spacebar-release correctly sends the dictated text.
  const stopRecording = useCallback(() => {
    if (speechModeRef.current === 'openai') {
      recorderRef.current?.stop();
      recorderRef.current = null;
      // The blob is sent inside the .then() callback above
    } else {
      if (stopRef.current) {
        stopRef.current();
        stopRef.current = null;
      }
      setRecording(false);
      const text = interimRef.current;
      if (text) {
        send({ type: 'user_utterance', text });
        setInterim('');
      }
    }
  }, [send]); // `interim` deliberately excluded — read via interimRef

  // Spacebar PTT — stable effect with [] deps; reads live values via refs.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        !recordingRef.current &&
        phaseRef.current === 'idle' &&
        canSpeakRef.current
      ) {
        e.preventDefault();
        startRecording();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && recordingRef.current) {
        e.preventDefault();
        stopRecording();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleScenarioChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setSelectedScenario(id);
    if (id) send({ type: 'choose_scenario', scenarioId: id });
  }

  function handleConfirm() {
    send({ type: 'confirm', yes: true });
  }

  function handleDecline() {
    send({ type: 'confirm', yes: false });
    send({ type: 'reset' });
  }

  function handleTextSubmit() {
    const text = textInput.trim();
    if (!text) return;
    send({ type: 'user_utterance', text });
    setTextInput('');
  }

  const displayInterim = interim || finalText;

  return (
    <div className="card">
      <div className="card-header">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="6" r="6"/>
        </svg>
        Request
      </div>
      <div className="card-body">
        {/* Scenario picker */}
        {state.scenarios.length > 0 && state.phase === 'idle' && (
          <div className="request-scenario">
            <label htmlFor="scenario-select">Demo scenario</label>
            <select
              id="scenario-select"
              className="select-scenario"
              value={selectedScenario}
              onChange={handleScenarioChange}
            >
              <option value="">— or speak your own —</option>
              {state.scenarios.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Mic error notice */}
        {micError && (
          <p className="mic-error" role="alert">
            Microphone unavailable — please type your request below.
          </p>
        )}

        {/* Voice input */}
        {canSpeak && state.phase === 'idle' && !micError && (
          <div className="ptt-wrap">
            <button
              className={`ptt-btn${recording ? ' active' : ''}`}
              onPointerDown={startRecording}
              onPointerUp={stopRecording}
              onPointerLeave={recording ? stopRecording : undefined}
              aria-label={recording ? 'Recording — release to send' : 'Hold to talk'}
              aria-pressed={recording}
            >
              <MicIcon />
            </button>
            <span className="ptt-hint">
              {recording ? 'Listening…' : 'Hold to talk · or press Space'}
            </span>
            {displayInterim && (
              <p className="ptt-interim">{displayInterim}</p>
            )}
          </div>
        )}

        {/* Text fallback — always shown when no mic, or after mic error */}
        {(!canSpeak || micError) && state.phase === 'idle' && (
          <div className="text-input-wrap">
            <textarea
              className="text-input"
              placeholder="Describe your booking request…"
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSubmit(); } }}
              rows={2}
              aria-label="Booking request"
            />
            <button
              className="btn-primary"
              onClick={handleTextSubmit}
              disabled={!textInput.trim()}
            >
              Send
            </button>
          </div>
        )}

        {/* Understood summary + confirm/decline */}
        {isUnderstanding && state.request && (
          <div>
            <div className="request-summary">
              <p>Understood:</p>
              <strong>{state.request.summary}</strong>
            </div>
            <div className="confirm-row">
              <button className="btn-secondary" onClick={handleDecline}>
                That's not right
              </button>
              <button className="btn-primary" onClick={handleConfirm}>
                Yes, start the call
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
