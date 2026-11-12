import type { SpeechMode } from '../shared/types.js';

export interface Config {
  anthropicKey: string;
  openaiKey?: string;
  speechMode: SpeechMode;
  callerModel: string;
  receptionistModel: string;
  interpretModel: string;
  callerEffort: 'low' | 'medium' | 'high';
  receptionistEffort: 'low' | 'medium' | 'high';
  today: string;
  holdScale: number;
  port: number;
}

function parseEffort(value: string | undefined, fallback: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return fallback;
}

function todayLocal(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function loadConfig(env: Partial<NodeJS.ProcessEnv>): Config {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error('Missing required environment variable: ANTHROPIC_API_KEY');
  }

  const openaiKey = env.OPENAI_API_KEY || undefined;
  const speechMode: SpeechMode = openaiKey ? 'openai' : 'browser';

  const callerModel = env.CALLER_MODEL || 'claude-sonnet-5-5';
  const receptionistModel = env.RECEPTIONIST_MODEL || 'claude-haiku-5-5';
  const interpretModel = env.INTERPRET_MODEL || 'claude-haiku-5-5';

  const callerEffort = parseEffort(env.CALLER_EFFORT, 'low');
  const receptionistEffort = parseEffort(env.RECEPTIONIST_EFFORT, 'low');

  const today = env.TODAY || todayLocal();

  const holdScale = env.HOLD_SCALE !== undefined ? parseFloat(env.HOLD_SCALE) : 1;
  const port = env.PORT !== undefined ? parseInt(env.PORT, 10) : 3001;

  return {
    anthropicKey,
    openaiKey,
    speechMode,
    callerModel,
    receptionistModel,
    interpretModel,
    callerEffort,
    receptionistEffort,
    today,
    holdScale,
    port,
  };
}
