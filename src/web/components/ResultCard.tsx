import { useState } from 'react';
import type { CallOutcome } from '../../shared/types.js';
import type { ClientMsg } from '../../shared/protocol.js';
import type { TranscriptEntry } from '../ws.js';

interface Props {
  outcome: CallOutcome;
  ics?: string;
  transcript: TranscriptEntry[];
  send: (m: ClientMsg) => void;
}

const SPEAKER_LABELS: Record<string, string> = {
  agent: 'Agent',
  receptionist: 'Receptionist',
  ivr: 'IVR',
  user: 'You',
  assistant: 'Assistant',
};

function formatSlot(start?: string, end?: string): string {
  if (!start) return '';
  // "2026-11-19T10:30" → "Thu 19 Nov, 10:30"
  try {
    const d = new Date(start.replace('T', ' '));
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = days[d.getDay()];
    const month = months[d.getMonth()];
    const time = start.slice(11, 16);
    return `${day} ${d.getDate()} ${month}, ${time}`;
  } catch {
    return start;
  }
}

function buildIcsHref(icsText: string): string {
  const blob = new Blob([icsText], { type: 'text/calendar' });
  return URL.createObjectURL(blob);
}

export function ResultCard({ outcome, ics, transcript, send }: Props) {
  const [showTranscript, setShowTranscript] = useState(false);

  const booked = outcome.status === 'booked';
  const booking = outcome.booking;
  const slotLabel = booking ? formatSlot(booking.start, booking.end) : '';
  const icsHref = ics ? buildIcsHref(ics) : undefined;

  function handleReset() {
    send({ type: 'reset' });
  }

  return (
    <div className="card">
      {/* Status header */}
      <div className={`result-status${booked ? '' : ' not-booked'}`}>
        <span className="result-icon">{booked ? '✅' : '❌'}</span>
        <div>
          <div className="result-title">
            {booked
              ? `${booking?.clinicName ?? 'Appointment'} booked`
              : 'Not booked'}
          </div>
          {slotLabel && (
            <div className="result-slot">{slotLabel}</div>
          )}
        </div>
      </div>

      {/* Action row */}
      <div className="result-actions">
        {icsHref && (
          <a
            href={icsHref}
            download="appointment.ics"
            className="btn-ics"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            Add to calendar (.ics)
          </a>
        )}
      </div>

      {/* Summary */}
      <div className="result-summary">{outcome.summary}</div>

      {/* Collapsible transcript */}
      {transcript.length > 0 && (
        <>
          <button
            className="transcript-toggle"
            aria-expanded={showTranscript}
            onClick={() => setShowTranscript(v => !v)}
          >
            <span>Full transcript ({transcript.length} lines)</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {showTranscript && (
            <div className="transcript-full transcript" aria-label="Full call transcript">
              {transcript.map((line, i) => (
                <div key={i} className={`transcript-line${line.meta === 'dtmf' ? ' dtmf' : ''}`}>
                  <span className="tl-icon">
                    {line.speaker === 'agent' ? '🤖' :
                     line.speaker === 'receptionist' ? '🏥' :
                     line.speaker === 'ivr' ? '📞' :
                     line.speaker === 'user' ? '👤' : '💬'}
                  </span>
                  <span className="tl-text">
                    <strong>{SPEAKER_LABELS[line.speaker] ?? line.speaker}: </strong>
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Footer */}
      <div className="result-footer">
        <button className="btn-secondary" onClick={handleReset}>
          New request
        </button>
      </div>
    </div>
  );
}
