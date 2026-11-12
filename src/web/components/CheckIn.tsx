import { useEffect, useRef, useState, useCallback } from 'react';
import type { ClientMsg } from '../../shared/protocol.js';
import type { Capabilities } from '../capabilities.js';
import { startListening } from '../browserSpeech.js';
import { shouldStartListening } from '../checkinGating.js';

interface Props {
  question: string;
  timeoutMs: number;
  capabilities: Capabilities;
  /** True once the Player has finished playing everything queued before this check-in. */
  readyToListen: boolean;
  send: (m: ClientMsg) => void;
}

export function CheckIn({ question, timeoutMs, capabilities, readyToListen, send }: Props) {
  const [remaining, setRemaining] = useState(Math.round(timeoutMs / 1000));
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [listening, setListening] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const sentRef = useRef(false);

  const canSpeak = capabilities.recognition && capabilities.mic;

  const submitText = useCallback((text: string) => {
    if (sentRef.current) return;
    sentRef.current = true;
    send({ type: 'user_utterance', text });
  }, [send]);

  // Auto-start listening only once the Player has finished playing queued audio.
  // Uses the pure shouldStartListening gate to avoid starting during TTS.
  useEffect(() => {
    if (!shouldStartListening(readyToListen, canSpeak, sentRef.current)) return;
    setListening(true);
    try {
      stopRef.current = startListening(
        (result) => {
          setInterim(result.text);
          if (result.final) {
            setFinalText(result.text);
            submitText(result.text);
          }
        },
        () => setListening(false),
      );
    } catch {
      setListening(false);
    }
    return () => {
      stopRef.current?.();
    };
  }, [readyToListen, canSpeak, submitText]);

  // Countdown
  useEffect(() => {
    if (remaining <= 0) return;
    const id = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(id); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [remaining]);

  function handleYes() { submitText('yes'); }
  function handleNo()  { submitText('no');  }

  function handleTextSubmit() {
    const text = textInput.trim();
    if (!text) return;
    submitText(text);
  }

  const totalSecs = Math.round(timeoutMs / 1000);
  const fraction = remaining / totalSecs;
  // SVG ring
  const r = 10;
  const circ = 2 * Math.PI * r;
  const dash = circ * fraction;

  return (
    <div className="card checkin-card">
      <div className="card-header">
        ⏸ Checking with you
      </div>
      <div className="card-body">
        <p className="checkin-question">{question}</p>

        {/* Countdown ring */}
        <div className="checkin-countdown">
          <svg className="countdown-ring" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r={r} fill="none" stroke="var(--border)" strokeWidth="2"/>
            <circle
              cx="12" cy="12" r={r}
              fill="none"
              stroke="var(--warn)"
              strokeWidth="2"
              strokeDasharray={`${dash} ${circ}`}
              strokeLinecap="round"
              transform="rotate(-90 12 12)"
              style={{ transition: 'stroke-dasharray 1s linear' }}
            />
          </svg>
          {listening
            ? <span>Listening… {remaining}s</span>
            : readyToListen
              ? <span>{remaining}s to respond</span>
              : <span>Waiting for question to finish…</span>
          }
        </div>

        {/* Interim speech */}
        {(interim || finalText) && (
          <div className="checkin-interim">
            {interim || finalText}
          </div>
        )}

        {/* Text input fallback */}
        {!canSpeak && (
          <div className="text-input-wrap" style={{ marginBottom: '0.75rem' }}>
            <textarea
              className="text-input"
              placeholder="Type your answer…"
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSubmit(); } }}
              rows={2}
              aria-label="Your answer"
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

        {/* Yes / No fallback buttons */}
        <div className="checkin-fallback">
          <button className="btn-yes" onClick={handleYes} disabled={sentRef.current}>
            Yes
          </button>
          <button className="btn-no" onClick={handleNo} disabled={sentRef.current}>
            No
          </button>
          {canSpeak && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
              {listening ? 'or speak your answer' : 'Speech ended — tap a button'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
