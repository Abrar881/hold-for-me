import { useState, useEffect, useCallback, useRef } from 'react';
import type { ClientMsg } from '../../shared/protocol.js';
import type { SocketState } from '../ws.js';
import type { Capabilities } from '../capabilities.js';
import { startListening } from '../browserSpeech.js';

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
  const stopRef = useRef<(() => void) | null>(null);

  const canSpeak = capabilities.recognition && capabilities.mic;
  const isUnderstanding = state.phase === 'understanding';

  // Spacebar PTT
  useEffect(() => {
    if (!canSpeak) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !recording && state.phase === 'idle' && !isUnderstanding) {
        e.preventDefault();
        startRecording();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && recording) {
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
  });

  function startRecording() {
    if (recording) return;
    setRecording(true);
    setInterim('');
    setFinalText('');
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
    }
  }

  function stopRecording() {
    if (stopRef.current) {
      stopRef.current();
      stopRef.current = null;
    }
    setRecording(false);
    if (interim) {
      send({ type: 'user_utterance', text: interim });
      setInterim('');
    }
  }

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

        {/* Voice input */}
        {canSpeak && state.phase === 'idle' && (
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

        {/* Text fallback */}
        {!canSpeak && state.phase === 'idle' && (
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
