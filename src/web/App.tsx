import { useEffect, useRef, useState } from 'react';
import { useSocket } from './ws.js';
import { detectCapabilities } from './capabilities.js';
import { Player } from './audio.js';
import { RequestPanel } from './components/RequestPanel.js';
import { CallPanel } from './components/CallPanel.js';
import { CheckIn } from './components/CheckIn.js';
import { ResultCard } from './components/ResultCard.js';
import type { ClientMsg } from '../shared/protocol.js';

const capabilities = detectCapabilities(window as any);

const PhoneIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.5 2 2 0 0 1 3.6 1.32h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
  </svg>
);

const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

export function App() {
  const { state, send } = useSocket();
  const playerRef = useRef<Player | null>(null);
  // playerIdle tracks whether the Player's queue is empty.
  // CheckIn uses this to gate auto-listening until the question utterance has played.
  const [playerIdle, setPlayerIdle] = useState(true);

  // Initialise the player once, with a stable send reference.
  useEffect(() => {
    const player = new Player((msg: ClientMsg) => send(msg));
    playerRef.current = player;
    // Fire setPlayerIdle(true) whenever the queue drains.
    return player.onIdle(() => setPlayerIdle(true));
  }, [send]);

  // Sync listen-in state to player.
  useEffect(() => {
    playerRef.current?.setListenIn(state.listenIn);
  }, [state.listenIn]);

  // Enqueue new utterances as they arrive.
  const prevTranscriptLen = useRef(0);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const newLines = state.transcript.slice(prevTranscriptLen.current);
    prevTranscriptLen.current = state.transcript.length;
    let enqueued = false;
    for (const line of newLines) {
      if (line.id) {
        player.enqueue({
          id: line.id,
          speaker: line.speaker,
          text: line.text,
          channel: line.channel ?? 'call',
          audioB64: line.audioB64,
          mime: line.mime,
          speechMode: state.speechMode,
        });
        enqueued = true;
      }
    }
    // Mark as not-idle as soon as work is queued; onIdle fires when done.
    if (enqueued) setPlayerIdle(false);
  }, [state.transcript, state.speechMode]);

  // Handle hold music.
  const prevCallPhase = useRef(state.callPhase);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (state.callPhase === 'hold' && prevCallPhase.current !== 'hold') {
      player.startHoldMusic();
    } else if (prevCallPhase.current === 'hold' && state.callPhase !== 'hold') {
      player.stopHoldMusic();
    }
    prevCallPhase.current = state.callPhase;
  }, [state.callPhase]);

  // Play chime when transitioning into checkin.
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    if (state.phase === 'checkin' && prevPhase.current !== 'checkin') {
      playerRef.current?.playChime();
    }
    prevPhase.current = state.phase;
  }, [state.phase]);

  // Play DTMF tones for ivr_key transcript entries.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || state.transcript.length === 0) return;
    const last = state.transcript[state.transcript.length - 1];
    if (last.meta === 'dtmf') {
      const digits = last.text.replace('Pressed: ', '');
      player.playDigits(digits);
    }
  }, [state.transcript]);

  const noSpeech = !capabilities.recognition || !capabilities.mic;

  const badgeClass = `header-badge${state.speechMode === 'openai' ? ' openai' : ''}`;
  const badgeLabel = state.speechMode === 'openai' ? 'voice: OpenAI ✓' : 'voice: browser';

  return (
    <div className="app">
      <header className="header">
        <div className="header-logo">
          <PhoneIcon />
          Hold For Me
        </div>
        {state.connected && (
          <span className={badgeClass}>{badgeLabel}</span>
        )}
      </header>

      <main className="main">
        {/* No-speech notice */}
        {noSpeech && (
          <div className="notice-banner" role="alert">
            <AlertIcon />
            <span>
              <strong>Microphone not available.</strong>{' '}
              Speech input is not supported or permission was denied in this browser.
              Use the text boxes to continue.
            </span>
          </div>
        )}

        {/* Connection status */}
        {!state.connected && (
          <div className="conn-status" aria-live="polite">
            <span className="conn-dot off" aria-hidden="true" />
            Connecting to server…
          </div>
        )}

        {/* Request panel — present until result */}
        {state.phase !== 'result' && (
          <RequestPanel
            state={state}
            capabilities={capabilities}
            send={send}
          />
        )}

        {/* Call panel — shown while calling or during check-in */}
        {(state.phase === 'calling' || state.phase === 'checkin') && (
          <CallPanel state={state} send={send} />
        )}

        {/* Check-in — overlaid when agent needs a decision */}
        {state.phase === 'checkin' && state.pendingQuestion && (
          <CheckIn
            question={state.pendingQuestion.question}
            timeoutMs={state.pendingQuestion.timeoutMs}
            capabilities={capabilities}
            readyToListen={playerIdle}
            send={send}
          />
        )}

        {/* Result card */}
        {state.phase === 'result' && state.outcome && (
          <ResultCard
            outcome={state.outcome}
            ics={state.ics}
            transcript={state.transcript}
            send={send}
          />
        )}
      </main>
    </div>
  );
}
