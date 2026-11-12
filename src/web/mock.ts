/**
 * Dev-only WebSocket mock — activated with ?mock=1.
 * Replays a scripted ServerMsg sequence so the UI can be eyeballed
 * without a live server.
 */
import type { ServerMsg, ClientMsg } from '../shared/protocol.js';

const SCRIPT: ServerMsg[] = [
  {
    type: 'hello',
    speechMode: 'browser',
    scenarios: [
      { id: 'bright-smile', label: 'Bright Smile Dental', requestText: 'Book a check-up at Bright Smile next week, mornings, not Wednesday.' },
      { id: 'clearview', label: 'Clearview Opticians', requestText: 'Eye test at Clearview next week, mornings.' },
    ],
  },
];

/** Returns the full scenario playback script after the user sends confirm. */
function buildCallScript(scenarioId: string): ServerMsg[] {
  const clinic = scenarioId === 'clearview' ? 'Clearview Opticians' : 'Bright Smile Dental';
  const service = scenarioId === 'clearview' ? 'eye test' : 'check-up';
  const slot = scenarioId === 'clearview' ? '2026-11-19T10:00' : '2026-11-19T10:30';

  return [
    {
      type: 'request_understood',
      request: {
        clinicId: scenarioId,
        service,
        patientName: 'Alex Khan',
        dateFrom: '2026-11-16',
        dateTo: '2026-11-22',
        timeWindow: { start: '08:00', end: '12:00' },
        excludedWeekdays: [3],
      },
      summary: `${clinic} · ${service} · 16–22 Nov · mornings · not Wednesday`,
    },
    { type: 'call_status', phase: 'dialing' },
    {
      type: 'utterance',
      id: 'u1',
      speaker: 'ivr',
      text: 'Welcome to ' + clinic + '. Press 1 for appointments.',
      channel: 'call',
    },
    { type: 'ivr_key', digits: '1' },
    { type: 'hold', state: 'start', seconds: 20 },
    {
      type: 'utterance',
      id: 'u2',
      speaker: 'receptionist',
      text: `${clinic}, Sarah speaking. How can I help?`,
      channel: 'call',
    },
    { type: 'hold', state: 'end' },
    { type: 'call_status', phase: 'talking' },
    {
      type: 'utterance',
      id: 'u3',
      speaker: 'agent',
      text: `Hi, I'm an AI assistant calling on behalf of Alex Khan to book a ${service}.`,
      channel: 'call',
    },
    {
      type: 'utterance',
      id: 'u4',
      speaker: 'receptionist',
      text: 'Of course. We have Thursday the 19th at 10:30 available.',
      channel: 'call',
    },
    { type: 'call_status', phase: 'paused' },
    {
      type: 'needs_user',
      question: 'They offer Thursday 19 Nov at 10:30. Shall I book that?',
      timeoutMs: 15000,
      attempt: 1,
    },
  ];
}

function buildBookedScript(scenarioId: string): ServerMsg[] {
  const clinic = scenarioId === 'clearview' ? 'Clearview Opticians' : 'Bright Smile Dental';
  const service = scenarioId === 'clearview' ? 'eye test' : 'check-up';
  const slot = '2026-11-19T10:30';

  return [
    { type: 'call_status', phase: 'talking' },
    {
      type: 'utterance',
      id: 'u5',
      speaker: 'agent',
      text: `Great, I'll confirm that. Alex will be there Thursday at 10:30.`,
      channel: 'call',
    },
    {
      type: 'utterance',
      id: 'u6',
      speaker: 'receptionist',
      text: 'Wonderful, see you then!',
      channel: 'call',
    },
    {
      type: 'call_ended',
      outcome: {
        status: 'booked',
        booking: {
          clinicId: scenarioId,
          clinicName: clinic,
          slotId: 'slot-thu-1030',
          start: slot,
          end: '2026-11-19T11:00',
        },
        summary: `Booked a ${service} at ${clinic} for Thursday 19 Nov at 10:30.`,
        transcript: [],
      },
      ics: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        `SUMMARY:${service} at ${clinic}`,
        'DTSTART:20261119T103000',
        'DTEND:20261119T110000',
        `LOCATION:${clinic}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    },
  ];
}

type EventHandler = (ev: Event | MessageEvent) => void;

/** A fake WebSocket that replays scripted messages on a timer. */
export class MockSocket {
  private listeners = new Map<string, Set<EventHandler>>();
  private scenarioId = 'bright-smile';
  private confirmed = false;
  readyState = 1; // OPEN

  constructor() {
    setTimeout(() => this.fire('open', new Event('open')), 50);
    // Send initial hello
    setTimeout(() => this.fireMsg(SCRIPT[0]), 150);
  }

  addEventListener(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  send(data: string): void {
    try {
      const msg: ClientMsg = JSON.parse(data);
      this.onClientMsg(msg);
    } catch {
      // ignore
    }
  }

  close(): void {
    this.readyState = 3;
  }

  private onClientMsg(msg: ClientMsg): void {
    if (msg.type === 'choose_scenario') {
      this.scenarioId = msg.scenarioId;
    }
    if (msg.type === 'confirm' && msg.yes) {
      // Start the call script
      let delay = 300;
      for (const m of buildCallScript(this.scenarioId)) {
        setTimeout(() => this.fireMsg(m), delay);
        delay += 800;
      }
    }
    if (msg.type === 'user_utterance' || (msg.type === 'confirm' && msg.yes && this.confirmed)) {
      // After check-in, finish booking
      let delay = 500;
      for (const m of buildBookedScript(this.scenarioId)) {
        setTimeout(() => this.fireMsg(m), delay);
        delay += 1000;
      }
      this.confirmed = true;
    }
  }

  private fireMsg(msg: ServerMsg): void {
    const ev = new MessageEvent('message', { data: JSON.stringify(msg) });
    this.fire('message', ev);
  }

  private fire(event: string, ev: Event): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const h of handlers) h(ev);
    }
  }
}
