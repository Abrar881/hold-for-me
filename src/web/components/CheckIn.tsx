import { useEffect, useRef, useState, useCallback } from 'react';
import type { ClientMsg } from '../../shared/protocol.js';
import type { Capabilities } from '../capabilities.js';
import { startListening } from '../browserSpeech.js';
import { Recorder } from '../recorder.js';

interface Props {
  question: string;
  timeoutMs: number;
  capabilities: Capabilities;
  /** True once the Player has finished playing everything queued before this check-in. */
  readyToListen: boolean;
  speechMode: 'openai' | 'browser';
  send: (m: ClientMsg) => void;
}

export function CheckIn({ question, timeoutMs, capabilities, readyToListen, speechMode, send }: Props) {
  const [remaining, setRemaining] = useState(Math.round(timeoutMs / 1000));
  const [interim, setInterim] = useState('');
  const [finalText, setFinalText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [listening, setListening] = useState(false);
  // Real state so Yes/No buttons re-render when disabled.
  const [sent, setSent] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<Recorder | null>(null);

  const canSpeak = capabilities.recognition && capabilities.mic;

  const submitText = useCallback((text: string) => {
    setSent(prev => {
      if (prev) return prev;
      send({ type: 'user_utterance', text });
      return true;
    });
  }, [send]);

  const submitAudio = useCallback((blob: Blob) => {
    setSent(prev => {
      if (prev) return prev;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        send({ type: 'user_utterance', audioB64: base64, mime: blob.type });
      };
      reader.readAsDataURL(blob);
      return true;
    });
  }, [send]);

  // Auto-start listening only once readyToListen is true (the question utterance
  // has been played) and no answer has been sent yet.
  useEffect(() => {
    if (!readyToListen || !canSpeak || sent) return;

    if (speechMode === 'openai') {
      // OpenAI mode: record with auto-stop VAD
      const rec = new Recorder();
      recorderRef.current = rec;
      setListening(true);
      rec.start({ autoStop: true, maxMs: 15000 })
        .then(blob => {
          recorderRef.current = null;
          setListening(false);
          submitAudio(blob);
        })
        .catch(() => {
          recorderRef.current = null;
          setListening(false);
        });
      return () => {
        recorderRef.current?.stop();
        recorderRef.current = null;
      };
    } else {
      // Browser speech recognition mode
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
        stopRef.current = null;
      };
    }
  }, [readyToListen, canSpeak, sent, speechMode, submitAudio, submitText]);

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
          <button className="btn-yes" onClick={handleYes} disabled={sent}>
            Yes
          </button>
          <button className="btn-no" onClick={handleNo} disabled={sent}>
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
