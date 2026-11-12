import type { BookingRequest, CallOutcome, GateResult, Offer } from './types.js';

// Messages sent from server to client
export type ServerMsg =
  | { type: 'hello'; speechMode: 'openai' | 'browser'; scenarios: { id: string; label: string; requestText: string }[] }
  | { type: 'utterance'; id: string; speaker: string; text: string; channel: 'call' | 'user'; audioB64?: string; mime?: string }
  | { type: 'request_understood'; request: BookingRequest; summary: string }
  | { type: 'call_status'; phase: 'dialing' | 'ivr' | 'hold' | 'talking' | 'paused' | 'ended' }
  | { type: 'ivr_key'; digits: string }
  | { type: 'hold'; state: 'start' | 'end'; seconds?: number }
  | { type: 'needs_user'; question: string; timeoutMs: number; attempt: number }
  | { type: 'offer'; offer: Offer; gate: GateResult }
  | { type: 'call_ended'; outcome: CallOutcome; ics?: string }
  | { type: 'error'; message: string };

// Messages sent from client to server
export type ClientMsg =
  | { type: 'user_utterance'; text?: string; audioB64?: string; mime?: string }
  | { type: 'choose_scenario'; scenarioId: string }
  | { type: 'confirm'; yes: boolean }
  | { type: 'played'; id: string }
  | { type: 'listen_in'; on: boolean }
  | { type: 'reset' };
