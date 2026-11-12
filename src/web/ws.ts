import { useEffect, useReducer, useRef, useCallback } from 'react';
import type { ServerMsg, ClientMsg } from '../shared/protocol.js';
import type { BookingRequest, CallOutcome, Offer, GateResult } from '../shared/types.js';

export interface TranscriptEntry {
  id?: string;
  speaker: string;
  text: string;
  channel?: 'call' | 'user';
  audioB64?: string;
  mime?: string;
  meta?: string;
}

export interface SocketState {
  connected: boolean;
  phase: 'idle' | 'understanding' | 'calling' | 'checkin' | 'result';
  speechMode: 'openai' | 'browser';
  scenarios: { id: string; label: string; requestText: string }[];
  transcript: TranscriptEntry[];
  request?: { request: BookingRequest; summary: string };
  pendingQuestion?: { question: string; timeoutMs: number; attempt: number };
  outcome?: CallOutcome;
  ics?: string;
  callPhase?: 'dialing' | 'ivr' | 'hold' | 'talking' | 'paused' | 'ended';
  listenIn: boolean;
  holdSeconds: number;
  error?: string;
  lastOffer?: { offer: Offer; gate: GateResult };
}

const initialState: SocketState = {
  connected: false,
  phase: 'idle',
  speechMode: 'browser',
  scenarios: [],
  transcript: [],
  listenIn: true,
  holdSeconds: 0,
};

type Action =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'msg'; msg: ServerMsg }
  | { type: 'set_listen_in'; on: boolean };

function reducer(state: SocketState, action: Action): SocketState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true, error: undefined };
    case 'disconnected':
      return { ...state, connected: false };
    case 'set_listen_in':
      return { ...state, listenIn: action.on };
    case 'msg': {
      const msg = action.msg;
      switch (msg.type) {
        case 'hello':
          return {
            ...state,
            speechMode: msg.speechMode,
            scenarios: msg.scenarios,
            phase: 'idle',
            transcript: [],
            request: undefined,
            pendingQuestion: undefined,
            outcome: undefined,
            ics: undefined,
            callPhase: undefined,
          };
        case 'utterance':
          return {
            ...state,
            transcript: [
              ...state.transcript,
              {
                id: msg.id,
                speaker: msg.speaker,
                text: msg.text,
                channel: msg.channel,
                audioB64: msg.audioB64,
                mime: msg.mime,
              },
            ],
          };
        case 'request_understood':
          return {
            ...state,
            request: { request: msg.request, summary: msg.summary },
            phase: 'understanding',
          };
        case 'call_status':
          return {
            ...state,
            callPhase: msg.phase,
            phase: msg.phase === 'ended' ? state.phase : 'calling',
          };
        case 'ivr_key':
          return {
            ...state,
            transcript: [
              ...state.transcript,
              { speaker: 'ivr', text: `Pressed: ${msg.digits}`, meta: 'dtmf' },
            ],
          };
        case 'hold': {
          const holdSeconds =
            msg.state === 'start' ? (msg.seconds ?? 0) : state.holdSeconds;
          // Drive callPhase directly from hold events so hold music triggers.
          const callPhase = msg.state === 'start' ? 'hold' : 'talking';
          return { ...state, holdSeconds, callPhase };
        }
        case 'needs_user':
          return {
            ...state,
            phase: 'checkin',
            pendingQuestion: {
              question: msg.question,
              timeoutMs: msg.timeoutMs,
              attempt: msg.attempt,
            },
          };
        case 'offer':
          return { ...state, lastOffer: { offer: msg.offer, gate: msg.gate } };
        case 'call_ended':
          return {
            ...state,
            outcome: msg.outcome,
            ics: msg.ics,
            phase: 'result',
            callPhase: 'ended',
            pendingQuestion: undefined,
          };
        case 'error':
          return { ...state, error: msg.message };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/** WebSocket hook. Connects to /ws and reduces ServerMsg into UI state. */
export function useSocket(): { state: SocketState; send: (m: ClientMsg) => void } {
  const [state, dispatch] = useReducer(reducer, initialState);
  const ws = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = useCallback((msg: ClientMsg) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;

    function connect() {
      // Support dev mock
      let socket: WebSocket;
      const params = new URLSearchParams(location.search);
      if (params.get('mock') === '1') {
        import('./mock.js').then(m => {
          const mockSock = new m.MockSocket() as unknown as WebSocket;
          ws.current = mockSock;
          setupSocket(mockSock);
        });
        return;
      }

      socket = new WebSocket(url);
      ws.current = socket;
      setupSocket(socket);
    }

    function setupSocket(socket: WebSocket) {
      socket.addEventListener('open', () => {
        dispatch({ type: 'connected' });
      });
      socket.addEventListener('message', (ev: MessageEvent) => {
        try {
          const msg: ServerMsg = JSON.parse(ev.data as string);
          dispatch({ type: 'msg', msg });
        } catch {
          // ignore malformed
        }
      });
      socket.addEventListener('close', () => {
        dispatch({ type: 'disconnected' });
        // Reconnect after 2s
        setTimeout(connect, 2000);
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    }

    connect();
    return () => {
      ws.current?.close();
    };
  }, []);

  // Expose a stable reference to the listen-in setter
  const extSend = useCallback(
    (msg: ClientMsg) => {
      if (msg.type === 'listen_in') {
        dispatch({ type: 'set_listen_in', on: msg.on });
      }
      send(msg);
    },
    [send],
  );

  return { state, send: extSend };
}
