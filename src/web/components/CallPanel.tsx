import { useEffect, useRef, useState } from 'react';
import type { SocketState, TranscriptEntry } from '../ws.js';
import type { ClientMsg } from '../../shared/protocol.js';

interface Props {
  state: SocketState;
  send: (m: ClientMsg) => void;
}

const SPEAKER_ICONS: Record<string, string> = {
  agent:        '🤖',
  receptionist: '🏥',
  ivr:          '📞',
  user:         '👤',
  assistant:    '💬',
};

function speakerLabel(speaker: string): string {
  const labels: Record<string, string> = {
    agent: 'Agent',
    receptionist: 'Receptionist',
    ivr: 'IVR',
    user: 'You',
    assistant: 'Assistant',
  };
  return labels[speaker] ?? speaker;
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function phaseName(phase?: string): string {
  switch (phase) {
    case 'dialing':  return 'Dialing…';
    case 'ivr':      return 'Menu';
    case 'hold':     return 'On hold';
    case 'talking':  return 'Connected';
    case 'paused':   return 'Checking with you';
    case 'ended':    return 'Ended';
    default:         return 'Connecting…';
  }
}

function phaseClass(phase?: string): string {
  if (phase === 'paused') return 'call-phase-badge paused';
  if (phase === 'dialing' || !phase) return 'call-phase-badge dialing';
  return 'call-phase-badge';
}

export function CallPanel({ state, send }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Start timer when phase enters calling
  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.transcript]);

  function toggleListenIn() {
    send({ type: 'listen_in', on: !state.listenIn });
  }

  const isWaiting =
    state.callPhase === 'talking' &&
    state.transcript.length > 0 &&
    state.transcript[state.transcript.length - 1].speaker !== 'agent';

  return (
    <div className="card">
      <div className="card-header">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="6" r="6"/>
        </svg>
        Live call
      </div>
      <div className="card-body">
        {/* Call status row */}
        <div className="call-header">
          <span className={phaseClass(state.callPhase)}>
            {phaseName(state.callPhase)}
          </span>

          {state.callPhase === 'hold' && (
            <span className="hold-indicator" title="On hold">
              🎵 On hold
            </span>
          )}

          <span className="call-timer">{formatTimer(elapsed)}</span>

          <button
            className={`listen-toggle${state.listenIn ? '' : ' muted'}`}
            onClick={toggleListenIn}
            aria-pressed={state.listenIn}
            title={state.listenIn ? 'Mute call audio' : 'Unmute call audio'}
          >
            {state.listenIn ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <line x1="23" y1="9" x2="17" y2="15"/>
                <line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            )}
            {state.listenIn ? 'Listening in' : 'Muted'}
          </button>
        </div>

        {/* Transcript */}
        <div className="transcript" ref={transcriptRef} aria-live="polite" aria-label="Call transcript">
          {state.transcript.map((line, i) => (
            <TranscriptLine key={i} line={line} />
          ))}
          {isWaiting && (
            <div className="thinking-indicator" aria-label="Agent is thinking">
              <span className="tl-icon">{SPEAKER_ICONS.agent}</span>
              <span className="dots">
                <span>·</span><span>·</span><span>·</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptLine({ line }: { line: TranscriptEntry }) {
  const icon = SPEAKER_ICONS[line.speaker] ?? '💬';
  const label = speakerLabel(line.speaker);
  const isDtmf = line.meta === 'dtmf';

  return (
    <div className={`transcript-line${isDtmf ? ' dtmf' : ''}`}>
      <span className="tl-icon" title={label}>{icon}</span>
      <span className="tl-text">
        {!isDtmf && <strong>{label}: </strong>}
        {line.text}
      </span>
    </div>
  );
}
